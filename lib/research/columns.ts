/**
 * Clay-style dynamic columns on research tables.
 * MCP / agent CRUD + enrich runners (AI prompt or people fields).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { runAiColumn } from "@/lib/research/ai-column";
import {
  getRow,
  getTable,
  listPeople,
  listRows,
  listTables,
} from "@/lib/research/tables";
import type {
  ResearchCell,
  ResearchColumn,
  ResearchColumnEnrich,
  ResearchColumnType,
  ResearchRow,
  ResearchTable,
} from "@/lib/research/types";
import { enrichPeopleForRow } from "@/lib/research/waterfall";

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Safe slug without ReDoS-prone regex on user input. */
export function slugifyName(name: string): string {
  const raw = name
    .toLowerCase()
    .normalize("NFKD")
    .slice(0, 120);
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    // skip combining marks
    if (code >= 0x0300 && code <= 0x036f) continue;
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9")
    ) {
      out += ch;
    } else if (out.length > 0 && out[out.length - 1] !== "-") {
      out += "-";
    }
    if (out.length >= 48) break;
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "list";
}

export async function ensureUniqueSlug(
  client: SupabaseClient,
  base: string,
  excludeId?: string,
): Promise<string> {
  let candidate = base.slice(0, 56);
  for (let i = 0; i < 12; i++) {
    const trySlug = i === 0 ? candidate : `${candidate}-${i + 1}`;
    const { data } = await client
      .from("research_tables")
      .select("id")
      .eq("slug", trySlug)
      .maybeSingle();
    if (!data || (excludeId && data.id === excludeId)) return trySlug;
  }
  return `${candidate}-${Date.now().toString(36).slice(-6)}`;
}

/** Resolve table by UUID, slug, or unique name (case-insensitive). */
export async function resolveTable(
  client: SupabaseClient,
  ref: string,
): Promise<ResearchTable> {
  const raw = ref.trim();
  if (!raw) throw new Error("table ref is empty");

  // UUID
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      raw,
    )
  ) {
    const t = await getTable(client, raw);
    if (!t) throw new Error(`Table not found: ${raw}`);
    return t;
  }

  // slug
  const { data: bySlug } = await client
    .from("research_tables")
    .select("id")
    .eq("slug", raw.toLowerCase())
    .maybeSingle();
  if (bySlug?.id) {
    const t = await getTable(client, bySlug.id as string);
    if (t) return t;
  }

  // unique name
  const all = await listTables(client);
  const lower = raw.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase() === lower);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous table name "${raw}" (${matches.length} matches). Use slug or id: ${matches
        .map((m) => `${m.slug ?? "?"} (${m.id.slice(0, 8)})`)
        .join(", ")}`,
    );
  }

  const partial = all.filter((t) => t.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Ambiguous table "${raw}". Candidates: ${partial
        .slice(0, 8)
        .map((m) => `${m.name} [slug=${m.slug}]`)
        .join("; ")}`,
    );
  }

  throw new Error(
    `Table not found: "${raw}". Use researchListTables to see id/slug/name.`,
  );
}

/** Safe snake_case key without ReDoS-prone regex on user input. */
function normalizeKey(key: string): string {
  const raw = key.trim().toLowerCase().slice(0, 80);
  let out = "";
  for (const ch of raw) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
    } else if (ch === "_" || ch === "-" || ch === " ") {
      if (out.length > 0 && out[out.length - 1] !== "_") out += "_";
    }
  }
  while (out.endsWith("_")) out = out.slice(0, -1);
  if (!KEY_RE.test(out)) {
    throw new Error(
      `Invalid column key "${key}". Use snake_case starting with a letter (e.g. contact_linkedin).`,
    );
  }
  return out;
}

function parseEnrich(input: unknown): ResearchColumnEnrich {
  if (!input || typeof input !== "object") return { kind: "none" };
  const e = input as Record<string, unknown>;
  const kind = String(e.kind ?? "none");
  if (kind === "ai") {
    const prompt = String(e.prompt ?? "").trim();
    if (!prompt) throw new Error("enrich.kind=ai requires prompt");
    return { kind: "ai", prompt };
  }
  if (kind === "people_field") {
    const field = String(e.field ?? "");
    if (!["linkedin", "email", "name", "role"].includes(field)) {
      throw new Error(
        "enrich.people_field.field must be linkedin|email|name|role",
      );
    }
    return {
      kind: "people_field",
      field: field as "linkedin" | "email" | "name" | "role",
      runPeopleIfMissing: e.runPeopleIfMissing !== false,
    };
  }
  return { kind: "none" };
}

async function loadColumns(
  client: SupabaseClient,
  tableId: string,
): Promise<ResearchColumn[]> {
  const t = await getTable(client, tableId);
  if (!t) throw new Error("Table not found");
  return [...(t.columns ?? [])].sort((a, b) => a.order - b.order);
}

async function saveColumns(
  client: SupabaseClient,
  tableId: string,
  columns: ResearchColumn[],
): Promise<ResearchColumn[]> {
  const sorted = [...columns].sort((a, b) => a.order - b.order);
  const { error } = await client
    .from("research_tables")
    .update({
      columns: sorted,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tableId);
  if (error) throw new Error(`Failed to save columns: ${error.message}`);
  return sorted;
}

export async function listColumns(
  client: SupabaseClient,
  tableRef: string,
): Promise<{ table: ResearchTable; columns: ResearchColumn[] }> {
  const table = await resolveTable(client, tableRef);
  return { table, columns: [...(table.columns ?? [])].sort((a, b) => a.order - b.order) };
}

export async function createColumn(
  client: SupabaseClient,
  tableRef: string,
  input: {
    key?: string;
    label: string;
    type?: ResearchColumnType;
    enrich?: unknown;
    order?: number;
  },
): Promise<{ table: ResearchTable; column: ResearchColumn; columns: ResearchColumn[] }> {
  const table = await resolveTable(client, tableRef);
  const label = input.label.trim();
  if (!label) throw new Error("label is required");

  const key = normalizeKey(input.key?.trim() || label);
  const columns = await loadColumns(client, table.id);
  if (columns.some((c) => c.key === key)) {
    throw new Error(`Column key already exists: ${key}`);
  }

  const type = (input.type ?? "text") as ResearchColumnType;
  if (!["text", "url", "email", "boolean", "number"].includes(type)) {
    throw new Error(`Invalid type: ${type}`);
  }

  const maxOrder = columns.reduce((m, c) => Math.max(m, c.order), -1);
  const column: ResearchColumn = {
    key,
    label,
    type,
    enrich: parseEnrich(input.enrich),
    order: typeof input.order === "number" ? input.order : maxOrder + 1,
    createdAt: new Date().toISOString(),
  };

  const next = await saveColumns(client, table.id, [...columns, column]);
  const updated = await getTable(client, table.id);
  return { table: updated!, column, columns: next };
}

export async function updateColumn(
  client: SupabaseClient,
  tableRef: string,
  key: string,
  patch: {
    label?: string;
    type?: ResearchColumnType;
    enrich?: unknown;
    order?: number;
    newKey?: string;
  },
): Promise<{ table: ResearchTable; column: ResearchColumn; columns: ResearchColumn[] }> {
  const table = await resolveTable(client, tableRef);
  const columns = await loadColumns(client, table.id);
  const idx = columns.findIndex((c) => c.key === key);
  if (idx < 0) throw new Error(`Column not found: ${key}`);

  const col = { ...columns[idx] };
  if (patch.label != null) col.label = patch.label.trim() || col.label;
  if (patch.type != null) col.type = patch.type;
  if (patch.enrich !== undefined) col.enrich = parseEnrich(patch.enrich);
  if (typeof patch.order === "number") col.order = patch.order;

  let nextKey = key;
  if (patch.newKey && patch.newKey !== key) {
    nextKey = normalizeKey(patch.newKey);
    if (columns.some((c) => c.key === nextKey)) {
      throw new Error(`Column key already exists: ${nextKey}`);
    }
    col.key = nextKey;
    // Rename cells on all rows
    const rows = await listRows(client, table.id);
    for (const row of rows) {
      const cells = { ...(row.cells ?? {}) };
      if (key in cells) {
        cells[nextKey] = cells[key];
        delete cells[key];
        await client
          .from("research_rows")
          .update({ cells, updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }
  }

  const next = [...columns];
  next[idx] = col;
  const saved = await saveColumns(client, table.id, next);
  const updated = await getTable(client, table.id);
  return {
    table: updated!,
    column: saved.find((c) => c.key === nextKey)!,
    columns: saved,
  };
}

export async function deleteColumn(
  client: SupabaseClient,
  tableRef: string,
  key: string,
  opts: { purgeCells?: boolean } = {},
): Promise<{ table: ResearchTable; columns: ResearchColumn[] }> {
  const table = await resolveTable(client, tableRef);
  const columns = await loadColumns(client, table.id);
  if (!columns.some((c) => c.key === key)) {
    throw new Error(`Column not found: ${key}`);
  }
  const next = await saveColumns(
    client,
    table.id,
    columns.filter((c) => c.key !== key),
  );

  if (opts.purgeCells !== false) {
    const rows = await listRows(client, table.id);
    for (const row of rows) {
      if (!row.cells?.[key]) continue;
      const cells = { ...row.cells };
      delete cells[key];
      await client
        .from("research_rows")
        .update({ cells, updated_at: new Date().toISOString() })
        .eq("id", row.id);
    }
  }

  const updated = await getTable(client, table.id);
  return { table: updated!, columns: next };
}

export async function setCell(
  client: SupabaseClient,
  rowId: string,
  columnKey: string,
  value: string | number | boolean | null,
  extra: Partial<ResearchCell> = {},
): Promise<ResearchCell> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error("Row not found");
  const cell: ResearchCell = {
    value,
    status: extra.status ?? "done",
    evidence: extra.evidence ?? null,
    sources: extra.sources ?? [],
    updatedAt: new Date().toISOString(),
    error: extra.error ?? null,
  };
  const cells = { ...(row.cells ?? {}), [columnKey]: cell };
  const { error } = await client
    .from("research_rows")
    .update({ cells, updated_at: new Date().toISOString() })
    .eq("id", rowId);
  if (error) throw new Error(`Failed to set cell: ${error.message}`);
  return cell;
}

async function markCellRunning(
  client: SupabaseClient,
  rowId: string,
  columnKey: string,
): Promise<void> {
  const row = await getRow(client, rowId);
  if (!row) return;
  const prev = row.cells?.[columnKey];
  const cells = {
    ...(row.cells ?? {}),
    [columnKey]: {
      value: prev?.value ?? null,
      status: "running" as const,
      evidence: prev?.evidence ?? null,
      sources: prev?.sources ?? [],
      updatedAt: new Date().toISOString(),
    },
  };
  await client
    .from("research_rows")
    .update({ cells, updated_at: new Date().toISOString() })
    .eq("id", rowId);
}

async function runPeopleFieldCell(
  client: SupabaseClient,
  row: ResearchRow,
  column: ResearchColumn,
): Promise<ResearchCell> {
  const enrich = column.enrich;
  if (enrich.kind !== "people_field") {
    throw new Error("Not a people_field column");
  }

  let people = await listPeople(client, row.id);
  if (
    people.length === 0 &&
    enrich.runPeopleIfMissing !== false &&
    row.domain
  ) {
    try {
      await enrichPeopleForRow(client, row.id, {
        onlyIfPass: false,
        maxPeople: 3,
      });
      people = await listPeople(client, row.id);
    } catch (err) {
      return {
        value: null,
        status: "failed",
        error: err instanceof Error ? err.message : "People enrich failed",
        updatedAt: new Date().toISOString(),
      };
    }
  }

  const top =
    people.find((p) => {
      if (enrich.field === "email") return Boolean(p.email);
      if (enrich.field === "linkedin") return Boolean(p.linkedin);
      return true;
    }) ?? people[0];

  if (!top) {
    return {
      value: null,
      status: "done",
      evidence: "No people found for this company",
      updatedAt: new Date().toISOString(),
    };
  }

  const value = (top[enrich.field] as string | null) ?? null;
  return {
    value,
    status: "done",
    evidence: top.role
      ? `${top.name} (${top.role})`
      : top.name,
    updatedAt: new Date().toISOString(),
  };
}

async function runAiFieldCell(
  client: SupabaseClient,
  rowId: string,
  column: ResearchColumn,
): Promise<ResearchCell> {
  if (column.enrich.kind !== "ai") throw new Error("Not an ai column");
  const result = await runAiColumn(client, rowId, column.enrich.prompt);
  // Also write into cells (runAiColumn still writes pack_raw for compat)
  const value =
    result.booleanAnswer != null
      ? result.booleanAnswer
      : result.answer;
  return {
    value,
    status: "done",
    evidence: result.evidence,
    sources: result.sources,
    updatedAt: new Date().toISOString(),
  };
}

export async function runColumnOnRow(
  client: SupabaseClient,
  rowId: string,
  column: ResearchColumn,
): Promise<ResearchCell> {
  await markCellRunning(client, rowId, column.key);
  try {
    let cell: ResearchCell;
    if (column.enrich.kind === "ai") {
      cell = await runAiFieldCell(client, rowId, column);
    } else if (column.enrich.kind === "people_field") {
      const row = await getRow(client, rowId);
      if (!row) throw new Error("Row not found");
      cell = await runPeopleFieldCell(client, row, column);
    } else {
      cell = {
        value: null,
        status: "done",
        evidence: "Column has no enrich kind — set value manually",
        updatedAt: new Date().toISOString(),
      };
    }
    await setCell(client, rowId, column.key, cell.value, cell);
    return cell;
  } catch (err) {
    const cell: ResearchCell = {
      value: null,
      status: "failed",
      error: err instanceof Error ? err.message : "Column run failed",
      updatedAt: new Date().toISOString(),
    };
    await setCell(client, rowId, column.key, null, cell);
    return cell;
  }
}

export async function runColumn(
  client: SupabaseClient,
  tableRef: string,
  columnKey: string,
  opts: {
    rowIds?: string[];
    onlyMissing?: boolean;
    maxRows?: number;
  } = {},
): Promise<{
  table: ResearchTable;
  column: ResearchColumn;
  ok: number;
  failed: number;
  skipped: number;
  sample: Array<{ rowId: string; company: string; cell: ResearchCell }>;
}> {
  const table = await resolveTable(client, tableRef);
  const column = (table.columns ?? []).find((c) => c.key === columnKey);
  if (!column) throw new Error(`Column not found: ${columnKey}`);

  let rows = await listRows(client, table.id);
  if (opts.rowIds?.length) {
    const set = new Set(opts.rowIds);
    rows = rows.filter((r) => set.has(r.id));
  }
  if (opts.onlyMissing !== false) {
    rows = rows.filter((r) => {
      const c = r.cells?.[columnKey];
      if (!c) return true;
      if (c.status === "failed") return true;
      if (c.value == null || c.value === "") return true;
      return false;
    });
  }
  const cap = Math.min(opts.maxRows ?? 50, 100);
  rows = rows.slice(0, cap);

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const sample: Array<{ rowId: string; company: string; cell: ResearchCell }> =
    [];

  for (const row of rows) {
    if (column.enrich.kind === "none") {
      skipped += 1;
      continue;
    }
    const cell = await runColumnOnRow(client, row.id, column);
    if (cell.status === "failed") failed += 1;
    else ok += 1;
    if (sample.length < 8) {
      sample.push({ rowId: row.id, company: row.companyName, cell });
    }
  }

  const fresh = await getTable(client, table.id);
  return {
    table: fresh!,
    column,
    ok,
    failed,
    skipped,
    sample,
  };
}
