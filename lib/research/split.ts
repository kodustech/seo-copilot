/**
 * Horizontal list ops: move rows between lists, split by generic rules.
 * Rows are MOVEd (table_id update) so people + evidence stay on the same row ids.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createTable, getTable, listRows } from "@/lib/research/tables";
import type { ResearchRow, ResearchTable } from "@/lib/research/types";

// ---------------------------------------------------------------------------
// Conditions (generic matchers)
// ---------------------------------------------------------------------------

export type RowCondition =
  | { kind: "domain_suffix"; value: string }
  | { kind: "domain_includes"; value: string }
  | { kind: "company_includes"; value: string }
  | { kind: "company_regex"; value: string }
  | { kind: "source"; value: string }
  | { kind: "pass"; value: boolean }
  | { kind: "min_score"; value: number }
  | { kind: "max_score"; value: number }
  | { kind: "status"; value: string }
  | { kind: "cell_eq"; key: string; value: string }
  | { kind: "cell_includes"; key: string; value: string }
  | { kind: "pack_path_eq"; path: string; value: string }
  | { kind: "pack_path_includes"; path: string; value: string }
  | { kind: "pack_text_includes"; value: string }
  | { kind: "row_ids"; value: string[] };

export type SplitRule = {
  /** Destination list name (created if needed) */
  name: string;
  /** all = every condition must match; any = at least one */
  match?: "all" | "any";
  conditions: RowCondition[];
};

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function rowMatchesCondition(
  row: ResearchRow,
  c: RowCondition,
): boolean {
  const domain = (row.domain ?? "").toLowerCase();
  const company = row.companyName.toLowerCase();

  switch (c.kind) {
    case "domain_suffix":
      return domain.endsWith(c.value.toLowerCase());
    case "domain_includes":
      return domain.includes(c.value.toLowerCase());
    case "company_includes":
      return company.includes(c.value.toLowerCase());
    case "company_regex":
      try {
        return new RegExp(c.value, "i").test(row.companyName);
      } catch {
        return false;
      }
    case "source":
      return row.source.toLowerCase() === c.value.toLowerCase();
    case "pass":
      return row.pass === c.value;
    case "min_score":
      return row.icpScore != null && row.icpScore >= c.value;
    case "max_score":
      return row.icpScore != null && row.icpScore <= c.value;
    case "status":
      return row.status === c.value;
    case "cell_eq": {
      const cell = row.cells?.[c.key];
      return (
        String(cell?.value ?? "")
          .toLowerCase()
          .trim() === c.value.toLowerCase().trim()
      );
    }
    case "cell_includes": {
      const cell = row.cells?.[c.key];
      return String(cell?.value ?? "")
        .toLowerCase()
        .includes(c.value.toLowerCase());
    }
    case "pack_path_eq": {
      const v = getPath(row.packRaw, c.path);
      return String(v ?? "").toLowerCase() === c.value.toLowerCase();
    }
    case "pack_path_includes": {
      const v = getPath(row.packRaw, c.path);
      return String(v ?? "")
        .toLowerCase()
        .includes(c.value.toLowerCase());
    }
    case "pack_text_includes":
      return JSON.stringify(row.packRaw ?? {})
        .toLowerCase()
        .includes(c.value.toLowerCase());
    case "row_ids":
      return c.value.includes(row.id);
    default:
      return false;
  }
}

export function rowMatchesRule(row: ResearchRow, rule: SplitRule): boolean {
  if (!rule.conditions?.length) return false;
  const mode = rule.match ?? "any";
  if (mode === "all") {
    return rule.conditions.every((c) => rowMatchesCondition(row, c));
  }
  return rule.conditions.some((c) => rowMatchesCondition(row, c));
}

// ---------------------------------------------------------------------------
// Move rows (core primitive)
// ---------------------------------------------------------------------------

export async function moveRowsToTable(
  client: SupabaseClient,
  input: {
    rowIds: string[];
    /** Existing destination list */
    targetTableId?: string;
    /** Create a new list (uses shell of sourceTableId) */
    newTableName?: string;
    sourceTableId?: string;
    createdByEmail?: string | null;
  },
): Promise<{
  target: { id: string; slug: string | null; name: string };
  moved: number;
  skipped: number;
}> {
  const ids = [...new Set(input.rowIds.filter(Boolean))];
  if (ids.length === 0) {
    throw new Error("rowIds required");
  }

  let targetId = input.targetTableId?.trim() || null;
  let target: ResearchTable | null = targetId
    ? await getTable(client, targetId)
    : null;

  if (!target && input.newTableName?.trim()) {
    const sourceId = input.sourceTableId;
    if (!sourceId) {
      throw new Error("sourceTableId required when creating a new list");
    }
    const source = await getTable(client, sourceId);
    if (!source) throw new Error("Source table not found");
    target = await cloneTableShell(
      client,
      source,
      input.newTableName.trim(),
      input.createdByEmail,
    );
    targetId = target.id;
  }

  if (!target || !targetId) {
    throw new Error("Provide targetTableId or newTableName + sourceTableId");
  }

  // Don't move rows already on target
  const { data: already } = await client
    .from("research_rows")
    .select("id")
    .eq("table_id", targetId)
    .in("id", ids);
  const alreadySet = new Set((already ?? []).map((r) => r.id as string));
  const toMove = ids.filter((id) => !alreadySet.has(id));

  const moved = await moveRows(client, toMove, targetId);
  return {
    target: {
      id: target.id,
      slug: target.slug,
      name: target.name,
    },
    moved,
    skipped: ids.length - toMove.length,
  };
}

// ---------------------------------------------------------------------------
// Split by rules (N named buckets + optional remainder)
// ---------------------------------------------------------------------------

export type SplitByRulesResult = {
  sourceTableId: string;
  buckets: Array<{
    name: string;
    tableId: string;
    slug: string | null;
    moved: number;
    sample: Array<{ id: string; company: string; domain: string | null }>;
  }>;
  remainder: {
    name: string;
    tableId: string | null;
    slug: string | null;
    moved: number;
    leftInSource: number;
  } | null;
  dryRun: boolean;
  counts: Record<string, number>;
};

/**
 * Assign each row to the first matching rule (priority order).
 * remainder: "new_list" | "leave" | omit (default leave in source)
 */
export async function splitTableByRules(
  client: SupabaseClient,
  sourceTableId: string,
  opts: {
    rules: SplitRule[];
    /** What to do with rows that match no rule */
    remainder?: "leave" | "new_list";
    remainderName?: string;
    dryRun?: boolean;
    createdByEmail?: string | null;
  },
): Promise<SplitByRulesResult> {
  const source = await getTable(client, sourceTableId);
  if (!source) throw new Error("Source table not found");
  if (!opts.rules?.length) throw new Error("At least one rule is required");

  const rows = await listRows(client, sourceTableId);
  const assigned = new Map<string, string[]>(); // rule name → row ids
  for (const rule of opts.rules) {
    assigned.set(rule.name, []);
  }
  const remainderIds: string[] = [];

  for (const row of rows) {
    let hit: string | null = null;
    for (const rule of opts.rules) {
      if (rowMatchesRule(row, rule)) {
        hit = rule.name;
        break;
      }
    }
    if (hit) assigned.get(hit)!.push(row.id);
    else remainderIds.push(row.id);
  }

  const counts: Record<string, number> = {};
  for (const [name, ids] of assigned) counts[name] = ids.length;
  counts.__remainder = remainderIds.length;

  if (opts.dryRun !== false) {
    return {
      sourceTableId: source.id,
      dryRun: true,
      counts,
      buckets: opts.rules.map((rule) => ({
        name: rule.name,
        tableId: "(dry_run)",
        slug: null,
        moved: assigned.get(rule.name)?.length ?? 0,
        sample: rows
          .filter((r) => assigned.get(rule.name)?.includes(r.id))
          .slice(0, 6)
          .map((r) => ({
            id: r.id,
            company: r.companyName,
            domain: r.domain,
          })),
      })),
      remainder: {
        name: opts.remainderName ?? "Remainder",
        tableId: null,
        slug: null,
        moved: 0,
        leftInSource: remainderIds.length,
      },
    };
  }

  const buckets: SplitByRulesResult["buckets"] = [];
  for (const rule of opts.rules) {
    const ids = assigned.get(rule.name) ?? [];
    const dest = await cloneTableShell(
      client,
      source,
      rule.name,
      opts.createdByEmail,
    );
    const moved = await moveRows(client, ids, dest.id);
    buckets.push({
      name: rule.name,
      tableId: dest.id,
      slug: dest.slug,
      moved,
      sample: rows
        .filter((r) => ids.includes(r.id))
        .slice(0, 6)
        .map((r) => ({
          id: r.id,
          company: r.companyName,
          domain: r.domain,
        })),
    });
  }

  let remainder: SplitByRulesResult["remainder"] = {
    name: opts.remainderName ?? "Remainder",
    tableId: null,
    slug: null,
    moved: 0,
    leftInSource: remainderIds.length,
  };

  if (opts.remainder === "new_list" && remainderIds.length > 0) {
    const dest = await cloneTableShell(
      client,
      source,
      opts.remainderName?.trim() || `${source.name} — Other`,
      opts.createdByEmail,
    );
    const moved = await moveRows(client, remainderIds, dest.id);
    remainder = {
      name: dest.name,
      tableId: dest.id,
      slug: dest.slug,
      moved,
      leftInSource: 0,
    };
  }

  return {
    sourceTableId: source.id,
    dryRun: false,
    counts,
    buckets,
    remainder,
  };
}

// ---------------------------------------------------------------------------
// Preset helpers (optional — not product UI, just convenient rule packs)
// ---------------------------------------------------------------------------

/** Example rule pack: language/market heuristics (agent or advanced users). */
export function presetBrazilVsWorldRules(baseName: string): {
  rules: SplitRule[];
  remainderName: string;
} {
  return {
    rules: [
      {
        name: `${baseName} — Brasil`,
        match: "any",
        conditions: [
          { kind: "domain_suffix", value: ".br" },
          { kind: "domain_includes", value: ".com.br" },
          { kind: "pack_path_eq", path: "firmo.meta.hqCountry", value: "BR" },
          { kind: "pack_path_eq", path: "find.market", value: "brazil" },
          { kind: "pack_text_includes", value: "gupy" },
          { kind: "pack_text_includes", value: "brasil" },
        ],
      },
    ],
    remainderName: `${baseName} — Global`,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function cloneTableShell(
  client: SupabaseClient,
  source: ResearchTable,
  name: string,
  createdByEmail?: string | null,
): Promise<ResearchTable> {
  const table = await createTable(client, {
    name,
    rubricId: source.rubricId,
    rubricJson: source.rubricJson ?? null,
    description: source.description
      ? `${source.description} (from ${source.name})`
      : `From ${source.name}`,
    createdByEmail: createdByEmail ?? source.createdByEmail,
  });
  if (source.columns?.length) {
    await client
      .from("research_tables")
      .update({ columns: source.columns })
      .eq("id", table.id);
    return (await getTable(client, table.id)) ?? table;
  }
  return table;
}

async function moveRows(
  client: SupabaseClient,
  rowIds: string[],
  targetTableId: string,
): Promise<number> {
  if (rowIds.length === 0) return 0;
  let moved = 0;
  const chunk = 80;
  for (let i = 0; i < rowIds.length; i += chunk) {
    const ids = rowIds.slice(i, i + chunk);
    const { error } = await client
      .from("research_rows")
      .update({
        table_id: targetTableId,
        updated_at: new Date().toISOString(),
      })
      .in("id", ids);
    if (error) throw new Error(`Failed to move rows: ${error.message}`);
    moved += ids.length;
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Backward-compatible market split (implemented as rules preset)
// ---------------------------------------------------------------------------

/** @deprecated Prefer splitTableByRules + presets */
export async function splitTableByMarket(
  client: SupabaseClient,
  sourceTableId: string,
  opts: {
    brazilName?: string;
    worldName?: string;
    unknownName?: string;
    unknownIntoWorld?: boolean;
    createdByEmail?: string | null;
    dryRun?: boolean;
  } = {},
) {
  const source = await getTable(client, sourceTableId);
  if (!source) throw new Error("Source table not found");
  const base = source.name;
  const preset = presetBrazilVsWorldRules(base);
  if (opts.brazilName) preset.rules[0].name = opts.brazilName;
  if (opts.worldName) preset.remainderName = opts.worldName;

  const result = await splitTableByRules(client, sourceTableId, {
    rules: preset.rules,
    remainder: opts.unknownIntoWorld === false ? "new_list" : "new_list",
    remainderName:
      opts.unknownIntoWorld === false && opts.unknownName
        ? opts.unknownName
        : preset.remainderName,
    dryRun: opts.dryRun,
    createdByEmail: opts.createdByEmail,
  });

  // Map to old shape for any leftover callers
  const br = result.buckets[0];
  const world = result.remainder;
  if (result.dryRun) {
    return {
      dryRun: true as const,
      sourceName: source.name,
      preview: {
        brazil: result.counts[br?.name ?? ""] ?? 0,
        world: result.counts.__remainder ?? 0,
        unknown: 0,
        samples: {
          brazil: (br?.sample ?? []).map((s) => ({
            ...s,
            why: "rule",
          })),
          world: [],
          unknown: [],
        },
      },
    };
  }
  return {
    sourceTableId: source.id,
    brazilTable: {
      id: br?.tableId ?? "",
      slug: br?.slug ?? null,
      name: br?.name ?? "",
      moved: br?.moved ?? 0,
    },
    worldTable: {
      id: world?.tableId ?? "",
      slug: world?.slug ?? null,
      name: world?.name ?? "",
      moved: world?.moved ?? 0,
    },
    unknownTable: null,
    preview: {
      brazil: br?.moved ?? 0,
      world: world?.moved ?? 0,
      unknown: 0,
      samples: { brazil: [], world: [], unknown: [] },
    },
  };
}

export async function previewSplitByMarket(
  client: SupabaseClient,
  tableId: string,
) {
  const r = await splitTableByMarket(client, tableId, { dryRun: true });
  return (r as { preview: {
    brazil: number;
    world: number;
    unknown: number;
    samples: {
      brazil: Array<{ id: string; company: string; domain: string | null; why: string }>;
      world: Array<{ id: string; company: string; domain: string | null; why: string }>;
      unknown: Array<{ id: string; company: string; domain: string | null; why: string }>;
    };
  } }).preview;
}
