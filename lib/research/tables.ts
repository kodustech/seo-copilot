import type { SupabaseClient } from "@supabase/supabase-js";

import { getDefaultRubricId, getRubric, listRubrics } from "@/lib/research/rubrics";
import type {
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
  rubric_id: string;
  rubric_json: Rubric | null;
  description: string | null;
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
  last_researched_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function mapTable(r: TableRow, rowCount?: number): ResearchTable {
  return {
    id: r.id,
    name: r.name,
    rubricId: r.rubric_id,
    rubricJson: r.rubric_json ?? null,
    description: r.description,
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
  },
): Promise<ResearchTable> {
  const rubricId = input.rubricId ?? getDefaultRubricId();
  if (!input.rubricJson) getRubric(rubricId); // validate built-in reference

  const { data, error } = await client
    .from("research_tables")
    .insert({
      name: input.name.trim(),
      rubric_id: input.rubricJson ? (input.rubricJson.id ?? rubricId) : rubricId,
      rubric_json: input.rubricJson ?? null,
      description: input.description ?? null,
      created_by_email: input.createdByEmail ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create research table: ${error.message}`);
  return mapTable(data as TableRow, 0);
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
      // No domain (common for Gupy): dedupe by company name.
      const { data: existing } = await client
        .from("research_rows")
        .select("id")
        .eq("table_id", tableId)
        .is("domain", null)
        .ilike("company_name", companyName)
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
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
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
  }));
}

export async function saveScore(
  client: SupabaseClient,
  rowId: string,
  score: ScoreResult,
  packRaw: Record<string, unknown>,
): Promise<void> {
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

export async function replacePeople(
  client: SupabaseClient,
  rowId: string,
  people: Array<{
    name: string;
    role?: string | null;
    linkedin?: string | null;
    email?: string | null;
    emailStatus?: string | null;
    emailSource?: string | null;
    providerUsed?: string | null;
    confidence?: number | null;
    notes?: string | null;
  }>,
): Promise<void> {
  await client.from("research_people").delete().eq("row_id", rowId);
  if (people.length === 0) return;
  const { error } = await client.from("research_people").insert(
    people.map((p) => ({
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
