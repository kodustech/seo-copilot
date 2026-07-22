import type { SupabaseClient } from "@supabase/supabase-js";

import { getDefaultRubricId, getRubric, listRubrics } from "@/lib/research/rubrics";
import type {
  ResearchCell,
  ResearchColumn,
  ResearchEvidence,
  ResearchPerson,
  ResearchRow,
  ResearchRun,
  ResearchTable,
  RowSource,
  Rubric,
  ScoreResult,
} from "@/lib/research/types";
import { normalizeDomain } from "@/lib/crm";

type TableRow = {
  id: string;
  name: string;
  slug: string | null;
  rubric_id: string;
  rubric_json: Rubric | null;
  description: string | null;
  columns: ResearchColumn[] | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

type DataRow = {
  id: string;
  table_id: string;
  company_name: string;
  domain: string | null;
  source: string;
  status: string;
  icp_score: number | null;
  trigger_score: number | null;
  fit_score: number | null;
  anti_flags: string[] | null;
  why_now: string | null;
  pass: boolean | null;
  pack_raw: Record<string, unknown> | null;
  cells: Record<string, ResearchCell> | null;
  last_researched_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function mapTable(r: TableRow, rowCount?: number): ResearchTable {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug ?? null,
    rubricId: r.rubric_id,
    rubricJson: r.rubric_json ?? null,
    description: r.description,
    columns: Array.isArray(r.columns) ? r.columns : [],
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rowCount,
  };
}

function mapRow(r: DataRow): ResearchRow {
  return {
    id: r.id,
    tableId: r.table_id,
    companyName: r.company_name,
    domain: r.domain,
    source: r.source,
    status: r.status,
    icpScore: r.icp_score != null ? Number(r.icp_score) : null,
    triggerScore: r.trigger_score != null ? Number(r.trigger_score) : null,
    fitScore: r.fit_score != null ? Number(r.fit_score) : null,
    antiFlags: r.anti_flags ?? [],
    whyNow: r.why_now,
    pass: r.pass,
    packRaw: r.pack_raw ?? {},
    cells: (r.cells as Record<string, ResearchCell>) ?? {},
    lastResearchedAt: r.last_researched_at,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export { listRubrics, getRubric, getDefaultRubricId };

export async function listTables(
  client: SupabaseClient,
): Promise<ResearchTable[]> {
  const { data, error } = await client
    .from("research_tables")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list research tables: ${error.message}`);

  const tables = (data ?? []) as TableRow[];
  const withCounts = await Promise.all(
    tables.map(async (t) => {
      const { count } = await client
        .from("research_rows")
        .select("id", { count: "exact", head: true })
        .eq("table_id", t.id);
      return mapTable(t, count ?? 0);
    }),
  );
  return withCounts;
}

export async function createTable(
  client: SupabaseClient,
  input: {
    name: string;
    rubricId?: string;
    /** Custom rubric compiled from a natural-language ICP; overrides rubricId at research time. */
    rubricJson?: Rubric | null;
    description?: string | null;
    createdByEmail?: string | null;
    slug?: string | null;
  },
): Promise<ResearchTable> {
  const rubricId = input.rubricId ?? getDefaultRubricId();
  if (!input.rubricJson) getRubric(rubricId); // validate built-in reference

  const { ensureUniqueSlug, slugifyName } = await import(
    "@/lib/research/columns"
  );
  const baseSlug = slugifyName(input.slug?.trim() || input.name);
  const slug = await ensureUniqueSlug(client, baseSlug);

  const { data, error } = await client
    .from("research_tables")
    .insert({
      name: input.name.trim(),
      slug,
      rubric_id: input.rubricJson ? (input.rubricJson.id ?? rubricId) : rubricId,
      rubric_json: input.rubricJson ?? null,
      description: input.description ?? null,
      columns: [],
      created_by_email: input.createdByEmail ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create research table: ${error.message}`);
  return mapTable(data as TableRow, 0);
}

export async function getTableBySlug(
  client: SupabaseClient,
  slug: string,
): Promise<ResearchTable | null> {
  const { data, error } = await client
    .from("research_tables")
    .select("*")
    .eq("slug", slug.trim().toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Failed to get table by slug: ${error.message}`);
  if (!data) return null;
  const { count } = await client
    .from("research_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", (data as TableRow).id);
  return mapTable(data as TableRow, count ?? 0);
}

export async function getTable(
  client: SupabaseClient,
  id: string,
): Promise<ResearchTable | null> {
  const { data, error } = await client
    .from("research_tables")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to get research table: ${error.message}`);
  if (!data) return null;
  const { count } = await client
    .from("research_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", id);
  return mapTable(data as TableRow, count ?? 0);
}

export async function deleteTable(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("research_tables").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete research table: ${error.message}`);
}

export async function addRows(
  client: SupabaseClient,
  tableId: string,
  rows: Array<{
    companyName: string;
    domain?: string | null;
    source?: RowSource | string;
    packRaw?: Record<string, unknown>;
  }>,
): Promise<{ added: number; skipped: number; rows: ResearchRow[] }> {
  let added = 0;
  let skipped = 0;
  const out: ResearchRow[] = [];

  for (const r of rows) {
    const domain = normalizeDomain(r.domain ?? null);
    const companyName = r.companyName.trim() || domain || "Unknown";
    if (!companyName && !domain) {
      skipped += 1;
      continue;
    }

    // Skip duplicate domain in same table.
    if (domain) {
      const { data: existing } = await client
        .from("research_rows")
        .select("id")
        .eq("table_id", tableId)
        .ilike("domain", domain)
        .maybeSingle();
      if (existing) {
        skipped += 1;
        continue;
      }
    } else {
      // No domain (common for discovery rows): dedupe by company name across
      // the whole table — an earlier research run may have filled in the
      // domain on a row that started domainless.
      const { data: existing } = await client
        .from("research_rows")
        .select("id")
        .eq("table_id", tableId)
        .ilike("company_name", companyName)
        .limit(1)
        .maybeSingle();
      if (existing) {
        skipped += 1;
        continue;
      }
    }

    const { data, error } = await client
      .from("research_rows")
      .insert({
        table_id: tableId,
        company_name: companyName,
        domain,
        source: r.source ?? "manual",
        status: "pending",
        pack_raw: r.packRaw ?? {},
      })
      .select("*")
      .single();

    if (error) {
      // unique race
      if (error.code === "23505") {
        skipped += 1;
        continue;
      }
      throw new Error(`Failed to add row: ${error.message}`);
    }
    added += 1;
    out.push(mapRow(data as DataRow));
  }

  return { added, skipped, rows: out };
}

export async function listRows(
  client: SupabaseClient,
  tableId: string,
  opts: {
    minScore?: number;
    passOnly?: boolean;
    status?: string;
  } = {},
): Promise<ResearchRow[]> {
  let q = client
    .from("research_rows")
    .select("*")
    .eq("table_id", tableId)
    .order("icp_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (opts.passOnly) q = q.eq("pass", true);
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.minScore != null) q = q.gte("icp_score", opts.minScore);

  const { data, error } = await q;
  if (error) throw new Error(`Failed to list research rows: ${error.message}`);
  return ((data ?? []) as DataRow[]).map(mapRow);
}

export async function getRow(
  client: SupabaseClient,
  rowId: string,
): Promise<ResearchRow | null> {
  const { data, error } = await client
    .from("research_rows")
    .select("*")
    .eq("id", rowId)
    .maybeSingle();
  if (error) throw new Error(`Failed to get research row: ${error.message}`);
  return data ? mapRow(data as DataRow) : null;
}

export async function listEvidence(
  client: SupabaseClient,
  rowId: string,
): Promise<ResearchEvidence[]> {
  const { data, error } = await client
    .from("research_evidence")
    .select("*")
    .eq("row_id", rowId)
    .order("kind")
    .order("criterion_id");
  if (error) throw new Error(`Failed to list evidence: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    rowId: r.row_id as string,
    criterionId: r.criterion_id as string,
    kind: r.kind as string,
    status: r.status as string,
    confidence: Number(r.confidence ?? 0),
    evidence: (r.evidence as string | null) ?? null,
    sources: (r.sources as ResearchEvidence["sources"]) ?? [],
    weight: Number(r.weight ?? 0),
    createdAt: r.created_at as string,
  }));
}

function mapPerson(r: Record<string, unknown>): ResearchPerson {
  return {
    id: r.id as string,
    rowId: r.row_id as string,
    name: r.name as string,
    role: (r.role as string | null) ?? null,
    linkedin: (r.linkedin as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    emailStatus: (r.email_status as string | null) ?? null,
    emailSource: (r.email_source as string | null) ?? null,
    providerUsed: (r.provider_used as string | null) ?? null,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export async function listPeople(
  client: SupabaseClient,
  rowId: string,
): Promise<ResearchPerson[]> {
  const { data, error } = await client
    .from("research_people")
    .select("*")
    .eq("row_id", rowId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list people: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapPerson);
}

/** Batch-load people for many rows (Clay grid). */
export async function listPeopleForRows(
  client: SupabaseClient,
  rowIds: string[],
): Promise<Map<string, ResearchPerson[]>> {
  const map = new Map<string, ResearchPerson[]>();
  if (rowIds.length === 0) return map;
  // Chunk to avoid oversized IN lists
  const chunkSize = 200;
  for (let i = 0; i < rowIds.length; i += chunkSize) {
    const chunk = rowIds.slice(i, i + chunkSize);
    const { data, error } = await client
      .from("research_people")
      .select("*")
      .in("row_id", chunk)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Failed to list people batch: ${error.message}`);
    for (const raw of data ?? []) {
      const p = mapPerson(raw as Record<string, unknown>);
      const list = map.get(p.rowId) ?? [];
      list.push(p);
      map.set(p.rowId, list);
    }
  }
  return map;
}

/** Postgres jsonb rejects the NUL escape (u0000) - scraped pages carry it. */
function stripNullChars<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value).replace(/(?<!\\)\\u0000/g, ""),
  ) as T;
}

export async function saveScore(
  client: SupabaseClient,
  rowId: string,
  score: ScoreResult,
  packRaw: Record<string, unknown>,
): Promise<void> {
  score = stripNullChars(score);
  packRaw = stripNullChars(packRaw);
  const { error } = await client
    .from("research_rows")
    .update({
      status: "researched",
      icp_score: score.icpScore,
      trigger_score: score.triggerScore,
      fit_score: score.fitScore,
      anti_flags: score.antiFlags,
      why_now: score.whyNow,
      pass: score.pass,
      pack_raw: packRaw,
      last_researched_at: new Date().toISOString(),
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
  if (error) throw new Error(`Failed to save score: ${error.message}`);

  // Replace evidence set.
  await client.from("research_evidence").delete().eq("row_id", rowId);
  if (score.criteria.length > 0) {
    const { error: e2 } = await client.from("research_evidence").insert(
      score.criteria.map((c) => ({
        row_id: rowId,
        criterion_id: c.criterionId,
        kind: c.kind,
        status: c.status,
        confidence: c.confidence,
        evidence: c.evidence,
        sources: c.sources,
        weight: c.weight,
      })),
    );
    if (e2) throw new Error(`Failed to save evidence: ${e2.message}`);
  }
}

export async function markRow(
  client: SupabaseClient,
  rowId: string,
  patch: {
    status?: string;
    error?: string | null;
    domain?: string | null;
  },
): Promise<void> {
  const { error } = await client
    .from("research_rows")
    .update({
      ...("status" in patch ? { status: patch.status } : {}),
      ...("error" in patch ? { error: patch.error } : {}),
      ...("domain" in patch
        ? { domain: normalizeDomain(patch.domain) }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
  if (error) throw new Error(`Failed to update row: ${error.message}`);
}

export async function createRun(
  client: SupabaseClient,
  input: {
    tableId: string | null;
    kind: string;
    createdBy?: string | null;
  },
): Promise<ResearchRun> {
  const { data, error } = await client
    .from("research_runs")
    .insert({
      table_id: input.tableId,
      kind: input.kind,
      status: "running",
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create run: ${error.message}`);
  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    tableId: (r.table_id as string | null) ?? null,
    kind: r.kind as string,
    status: r.status as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    summary: (r.summary as Record<string, unknown>) ?? {},
    lastError: (r.last_error as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
  };
}

export async function finishRun(
  client: SupabaseClient,
  runId: string,
  input: {
    status: "done" | "failed";
    summary?: Record<string, unknown>;
    lastError?: string | null;
  },
): Promise<void> {
  const { error } = await client
    .from("research_runs")
    .update({
      status: input.status,
      summary: input.summary ?? {},
      last_error: input.lastError ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(`Failed to finish run: ${error.message}`);
}

export async function getRun(
  client: SupabaseClient,
  runId: string,
): Promise<ResearchRun | null> {
  const { data, error } = await client
    .from("research_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`Failed to get run: ${error.message}`);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    tableId: (r.table_id as string | null) ?? null,
    kind: r.kind as string,
    status: r.status as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    summary: (r.summary as Record<string, unknown>) ?? {},
    lastError: (r.last_error as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
  };
}

export async function getLatestRun(
  client: SupabaseClient,
  tableId: string,
): Promise<ResearchRun | null> {
  const { data, error } = await client
    .from("research_runs")
    .select("*")
    .eq("table_id", tableId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get latest run: ${error.message}`);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    tableId: (r.table_id as string | null) ?? null,
    kind: r.kind as string,
    status: r.status as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    summary: (r.summary as Record<string, unknown>) ?? {},
    lastError: (r.last_error as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
  };
}

export type PersonWriteInput = {
  name: string;
  role?: string | null;
  linkedin?: string | null;
  email?: string | null;
  emailStatus?: string | null;
  emailSource?: string | null;
  providerUsed?: string | null;
  confidence?: number | null;
  notes?: string | null;
};

export type SavePeopleMode = "merge" | "replace";

function normalizePersonKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linkedInSlug(url: string | null | undefined): string | null {
  const li = url?.trim().toLowerCase().replace(/\/$/, "");
  if (!li) return null;
  const m = li.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (m) return m[1].toLowerCase();
  if (li.includes("linkedin")) return li;
  return null;
}

/**
 * All identity keys for a person. Matching uses ANY shared key so adding an
 * email does not create a second row (previous bug: only primary key was used,
 * and email beat name so Genevieve-without-email ≠ Genevieve-with-email).
 */
export function personIdentityKeys(p: {
  name: string;
  email?: string | null;
  linkedin?: string | null;
}): string[] {
  const keys: string[] = [];
  const email = p.email?.trim().toLowerCase();
  if (email) keys.push(`e:${email}`);
  const slug = linkedInSlug(p.linkedin);
  if (slug) keys.push(`li:${slug}`);
  const n = normalizePersonKey(p.name);
  if (n) keys.push(`n:${n}`);
  return keys;
}

/** @deprecated Prefer personIdentityKeys — kept for callers that want one key. */
function personMatchKey(p: {
  name: string;
  email?: string | null;
  linkedin?: string | null;
}): string {
  return personIdentityKeys(p)[0] ?? `n:${normalizePersonKey(p.name)}`;
}

function pickBetter(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const av = a?.trim() || null;
  const bv = b?.trim() || null;
  if (!av) return bv;
  if (!bv) return av;
  // Prefer longer / more complete
  return bv.length > av.length ? bv : av;
}

function mergeTwoPeople(
  a: PersonWriteInput,
  b: PersonWriteInput,
): PersonWriteInput {
  // Prefer email that is verified valid over bare address
  let email = a.email ?? b.email ?? null;
  let emailStatus = a.emailStatus ?? b.emailStatus ?? null;
  let emailSource = a.emailSource ?? b.emailSource ?? null;
  if (a.email && b.email && a.email.toLowerCase() !== b.email.toLowerCase()) {
    const rank = (s: string | null | undefined) =>
      s === "valid" ? 3 : s === "catchall" ? 2 : s === "unknown" ? 1 : 0;
    if (rank(b.emailStatus) > rank(a.emailStatus)) {
      email = b.email;
      emailStatus = b.emailStatus ?? null;
      emailSource = b.emailSource ?? null;
    } else {
      email = a.email;
      emailStatus = a.emailStatus ?? null;
      emailSource = a.emailSource ?? null;
    }
  } else if (!a.email && b.email) {
    email = b.email;
    emailStatus = b.emailStatus ?? null;
    emailSource = b.emailSource ?? null;
  } else if (a.email && !b.email) {
    email = a.email;
    emailStatus = a.emailStatus ?? null;
    emailSource = a.emailSource ?? null;
  } else if (a.email && b.email) {
    emailStatus = pickBetter(a.emailStatus, b.emailStatus);
    emailSource = pickBetter(a.emailSource, b.emailSource);
  }

  return {
    name: a.name.length >= b.name.length ? a.name : b.name,
    role: pickBetter(a.role, b.role),
    linkedin: pickBetter(a.linkedin, b.linkedin),
    email,
    emailStatus,
    emailSource,
    providerUsed: pickBetter(a.providerUsed, b.providerUsed),
    confidence: (() => {
      const m = Math.max(a.confidence ?? 0, b.confidence ?? 0);
      if (m > 0) return m;
      return a.confidence ?? b.confidence ?? null;
    })(),
    notes: pickBetter(a.notes, b.notes),
  };
}

/**
 * Collapse duplicates within a list: same person if they share email, LinkedIn
 * slug, or normalized name. Keeps the richest fields.
 */
export function dedupePersonList(
  people: PersonWriteInput[],
): PersonWriteInput[] {
  const clusters: PersonWriteInput[] = [];
  const keyToIdx = new Map<string, number>();

  for (const raw of people) {
    if (!raw.name?.trim()) continue;
    const p: PersonWriteInput = { ...raw, name: raw.name.trim() };
    const keys = personIdentityKeys(p);
    if (keys.length === 0) continue;

    let idx: number | undefined;
    for (const k of keys) {
      if (keyToIdx.has(k)) {
        idx = keyToIdx.get(k);
        break;
      }
    }

    if (idx === undefined) {
      idx = clusters.length;
      clusters.push(p);
    } else {
      clusters[idx] = mergeTwoPeople(clusters[idx], p);
    }

    // Re-index all keys of the (possibly merged) person
    for (const k of personIdentityKeys(clusters[idx])) {
      keyToIdx.set(k, idx);
    }
  }

  return clusters;
}

/**
 * Merge existing people with incoming. Never drops an existing contact.
 * Matches on ANY of email / LinkedIn / normalized name (multi-key).
 */
export function mergePersonLists(
  existing: PersonWriteInput[],
  incoming: PersonWriteInput[],
): PersonWriteInput[] {
  // Dedupe each side first, then union — same multi-key identity.
  return dedupePersonList([...existing, ...incoming]);
}

function peopleToJson(people: PersonWriteInput[]) {
  return people.map((p) => ({
    name: p.name,
    role: p.role ?? null,
    linkedin: p.linkedin ?? null,
    email: p.email ?? null,
    emailStatus: p.emailStatus ?? null,
    emailSource: p.emailSource ?? null,
    providerUsed: p.providerUsed ?? null,
    confidence: p.confidence ?? null,
    notes: p.notes ?? null,
  }));
}

/** Snapshot current people for a row (append-only history). Soft-fail if table missing. */
export async function snapshotPeople(
  client: SupabaseClient,
  rowId: string,
  opts: { reason?: string; createdBy?: string | null } = {},
): Promise<string | null> {
  const current = await listPeople(client, rowId);
  if (current.length === 0) return null;
  const payload = peopleToJson(current);
  const { data, error } = await client
    .from("research_people_snapshots")
    .insert({
      row_id: rowId,
      reason: opts.reason ?? "save",
      people: payload,
      person_count: payload.length,
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    // Table may not be migrated yet — don't block the write path
    console.warn("[research] snapshotPeople failed:", error.message);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

export async function listPeopleSnapshots(
  client: SupabaseClient,
  rowId: string,
  limit = 20,
): Promise<
  Array<{
    id: string;
    reason: string;
    personCount: number;
    people: PersonWriteInput[];
    createdBy: string | null;
    createdAt: string;
  }>
> {
  const { data, error } = await client
    .from("research_people_snapshots")
    .select("*")
    .eq("row_id", rowId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to list people snapshots: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    reason: (r.reason as string) ?? "save",
    personCount: Number(r.person_count ?? 0),
    people: (r.people as PersonWriteInput[]) ?? [],
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

/**
 * Restore people from a snapshot (merge by default so restore is additive-safe).
 */
export async function restorePeopleSnapshot(
  client: SupabaseClient,
  rowId: string,
  snapshotId: string,
  opts: { mode?: SavePeopleMode; createdBy?: string | null } = {},
): Promise<ResearchPerson[]> {
  const { data, error } = await client
    .from("research_people_snapshots")
    .select("*")
    .eq("id", snapshotId)
    .eq("row_id", rowId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Snapshot not found");
  const people = (data.people as PersonWriteInput[]) ?? [];
  return savePeople(client, rowId, people, {
    mode: opts.mode ?? "replace",
    reason: `restore:${snapshotId}`,
    createdBy: opts.createdBy,
  });
}

/**
 * Safe people write:
 * - Always snapshots existing people first (when any exist)
 * - mode "merge" (default): never drops existing contacts; fills gaps
 * - mode "replace": full replace (still snapshotted first)
 */
export async function savePeople(
  client: SupabaseClient,
  rowId: string,
  people: PersonWriteInput[],
  opts: {
    mode?: SavePeopleMode;
    reason?: string;
    createdBy?: string | null;
  } = {},
): Promise<ResearchPerson[]> {
  const mode: SavePeopleMode = opts.mode ?? "merge";
  const existing = await listPeople(client, rowId);

  if (existing.length > 0) {
    await snapshotPeople(client, rowId, {
      reason: opts.reason ?? mode,
      createdBy: opts.createdBy,
    });
  }

  const cleaned = people
    .map((p) => ({
      ...p,
      name: p.name.trim(),
    }))
    .filter((p) => p.name.length > 0);

  const existingWrite: PersonWriteInput[] = existing.map((p) => ({
    name: p.name,
    role: p.role,
    linkedin: p.linkedin,
    email: p.email,
    emailStatus: p.emailStatus,
    emailSource: p.emailSource,
    providerUsed: p.providerUsed,
    confidence: p.confidence,
    notes: p.notes,
  }));

  // Always multi-key dedupe so fill_email / enrich cannot fork identity.
  const next: PersonWriteInput[] = dedupePersonList(
    mode === "replace"
      ? cleaned
      : mergePersonLists(existingWrite, cleaned),
  );

  // Hard replace of the table rows with the merged set (IDs rotate — OK)
  await client.from("research_people").delete().eq("row_id", rowId);
  if (next.length > 0) {
    const { error } = await client.from("research_people").insert(
      next.map((p) => ({
        row_id: rowId,
        name: p.name,
        role: p.role ?? null,
        linkedin: p.linkedin ?? null,
        email: p.email ?? null,
        email_status: p.emailStatus ?? null,
        email_source: p.emailSource ?? null,
        provider_used: p.providerUsed ?? null,
        confidence: p.confidence ?? null,
        notes: p.notes ?? null,
      })),
    );
    if (error) throw new Error(`Failed to save people: ${error.message}`);
  }

  return listPeople(client, rowId);
}

/**
 * Mark research_people rows with this email as hard-bounced (ground-truth).
 * Also safe no-op when nobody matches.
 */
export async function markResearchPeopleEmailBounced(
  client: SupabaseClient,
  email: string,
  opts: { reason?: string } = {},
): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return 0;

  const { data, error } = await client
    .from("research_people")
    .select("id, row_id, name, role, linkedin, email, email_source, provider_used, confidence, notes")
    .ilike("email", normalized);
  if (error) {
    console.warn("[research] mark bounced failed:", error.message);
    return 0;
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return 0;

  const noteBit = `bounced:${opts.reason ?? "hard_bounce"}`;
  for (const r of rows) {
    const prevNotes = (r.notes as string | null) ?? null;
    const notes = prevNotes?.includes("bounced:")
      ? prevNotes
      : [prevNotes, noteBit].filter(Boolean).join(" | ");
    await client
      .from("research_people")
      .update({
        email_status: "bounced",
        confidence: 0,
        notes,
      })
      .eq("id", r.id as string);
  }
  return rows.length;
}

/**
 * Collapse duplicate contacts on one company row (name/LI/email multi-key).
 * Snapshots first. Safe to re-run.
 */
export async function dedupePeopleOnRow(
  client: SupabaseClient,
  rowId: string,
  opts: { createdBy?: string | null } = {},
): Promise<{ before: number; after: number; people: ResearchPerson[] }> {
  const existing = await listPeople(client, rowId);
  const before = existing.length;
  if (before <= 1) {
    return { before, after: before, people: existing };
  }
  const people = await savePeople(
    client,
    rowId,
    existing.map((p) => ({
      name: p.name,
      role: p.role,
      linkedin: p.linkedin,
      email: p.email,
      emailStatus: p.emailStatus,
      emailSource: p.emailSource,
      providerUsed: p.providerUsed,
      confidence: p.confidence,
      notes: p.notes,
    })),
    {
      // merge with empty incoming still runs dedupePersonList on existing
      mode: "merge",
      reason: "dedupe_people",
      createdBy: opts.createdBy,
    },
  );
  return { before, after: people.length, people };
}

/**
 * @deprecated Use savePeople({ mode: "merge" }). Kept for callers — now MERGES
 * by default so enrich/agent cannot silently wipe contacts. Pass mode:"replace"
 * only when an explicit full replace is intended (and a snapshot is still taken).
 */
export async function replacePeople(
  client: SupabaseClient,
  rowId: string,
  people: PersonWriteInput[],
  opts: {
    mode?: SavePeopleMode;
    reason?: string;
    createdBy?: string | null;
  } = {},
): Promise<void> {
  await savePeople(client, rowId, people, {
    mode: opts.mode ?? "merge",
    reason: opts.reason ?? "replacePeople",
    createdBy: opts.createdBy,
  });
}
