import type { SupabaseClient } from "@supabase/supabase-js";

import { listCompanies, type CompanyFilters } from "@/lib/crm";

import { enrollFromCrm } from "./sequences";

// ---------------------------------------------------------------------------
// Auto-enroll: a saved CRM filter pointed at a sequence.
//
// The two halves already existed — the accounts list takes filters, and
// enrollFromCrm takes company ids — with a human in between who had to ask the
// AI agent to bridge them. This runs that bridge on a schedule.
//
// Everything that decides *who is safe to contact* stays in enrollFromCrm:
// paying and closed accounts are suppressed, and accounts already in a
// sequence are skipped. Duplicating those rules here would mean two places to
// keep in sync and one of them would drift.
// ---------------------------------------------------------------------------

export type AutoEnrollRule = {
  id: string;
  sequenceId: string;
  name: string | null;
  filters: CompanyFilters;
  active: boolean;
  maxPerRun: number;
  allContacts: boolean;
  lastRunAt: string | null;
  lastResult: Record<string, unknown> | null;
  createdBy: string | null;
};

type RuleRow = {
  id: string;
  sequence_id: string;
  name: string | null;
  filters: CompanyFilters | null;
  active: boolean;
  max_per_run: number;
  all_contacts: boolean;
  last_run_at: string | null;
  last_result: Record<string, unknown> | null;
  created_by: string | null;
};

function rowToRule(r: RuleRow): AutoEnrollRule {
  return {
    id: r.id,
    sequenceId: r.sequence_id,
    name: r.name,
    filters: r.filters ?? {},
    active: r.active,
    maxPerRun: r.max_per_run,
    allContacts: r.all_contacts,
    lastRunAt: r.last_run_at,
    lastResult: r.last_result,
    createdBy: r.created_by,
  };
}

/** Filters a rule may carry. Anything else is dropped rather than passed
 *  through: an unknown key would silently widen the audience.
 *
 *  staleOnly is deliberately absent. listCompanies applies it in JS after the
 *  SQL LIMIT, so a capped query returns the most recent N and then filters them
 *  down — a stale rule would under-match by construction and never reach its
 *  cap, while the preview reported the shrunken number as if it were the whole
 *  audience. Excluding it removes the bug; supporting it means teaching
 *  listCompanies to resolve staleness in SQL, which is a change to a function
 *  the whole CRM depends on and does not belong in this feature. */
const ALLOWED_FILTERS = [
  "status",
  "priority",
  "tier",
  "deployment",
  "source",
  "ownerEmail",
  "search",
] as const;

export function sanitizeFilters(input: unknown): CompanyFilters {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_FILTERS) {
    const v = raw[key];
    if (v === undefined || v === null || v === "" || v === "all") continue;
    out[key] = v;
  }
  return out as CompanyFilters;
}

export async function listAutoEnrollRules(
  client: SupabaseClient,
  sequenceId?: string,
): Promise<AutoEnrollRule[]> {
  let q = client
    .from("outreach_auto_enroll_rules")
    .select("*")
    .order("created_at", { ascending: false });
  if (sequenceId) q = q.eq("sequence_id", sequenceId);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to list auto-enroll rules: ${error.message}`);
  return (data ?? []).map((r) => rowToRule(r as RuleRow));
}

export async function upsertAutoEnrollRule(
  client: SupabaseClient,
  input: {
    id?: string;
    sequenceId: string;
    name?: string | null;
    filters: unknown;
    active?: boolean;
    maxPerRun?: number;
    allContacts?: boolean;
    createdByEmail?: string | null;
  },
): Promise<AutoEnrollRule> {
  const filters = sanitizeFilters(input.filters);
  if (Object.keys(filters).length === 0) {
    // A rule with no filters means "every account in the CRM". That is never
    // what someone meant to save, and it is the one mistake with no undo.
    throw new Error("An auto-enroll rule needs at least one filter");
  }
  const row = {
    ...(input.id ? { id: input.id } : {}),
    sequence_id: input.sequenceId,
    name: input.name?.trim() || null,
    filters,
    active: input.active ?? false,
    max_per_run: Math.max(1, Math.min(input.maxPerRun ?? 10, 200)),
    all_contacts: input.allContacts ?? false,
    created_by: input.createdByEmail ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await client
    .from("outreach_auto_enroll_rules")
    .upsert(row)
    .select()
    .single();
  if (error) throw new Error(`Failed to save auto-enroll rule: ${error.message}`);
  return rowToRule(data as RuleRow);
}

export async function deleteAutoEnrollRule(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client
    .from("outreach_auto_enroll_rules")
    .delete()
    .eq("id", id);
  if (error) throw new Error(`Failed to delete auto-enroll rule: ${error.message}`);
}

export type AutoEnrollRunResult = {
  ruleId: string;
  matched: number;
  attempted: number;
  enrolled: number;
  skipped: number;
  errors: string[];
  dryRun: boolean;
};

/**
 * Resolve one rule and enrol whoever it matches.
 *
 * `dryRun` returns the same shape without writing, which is what the UI calls
 * before a rule is switched on — the audience of a filter is not obvious from
 * reading it, and the first run is the one that cannot be taken back.
 */
export async function runAutoEnrollRule(
  client: SupabaseClient,
  rule: AutoEnrollRule,
  opts?: { dryRun?: boolean },
): Promise<AutoEnrollRunResult> {
  const dryRun = opts?.dryRun ?? false;

  // Everyone this sequence has ever touched, at any status — not just the ones
  // currently active. enrollFromCrm suppresses active enrollments, which is the
  // right rule for a human enrolling once, and the wrong one for a job that
  // re-runs hourly: the moment an enrollment turns completed/replied/bounced
  // the account matches the filter again and the whole sequence goes out a
  // second time, to a real person, forever.
  const enrolledEver = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from("outreach_enrollments")
      .select("crm_company_id")
      .eq("sequence_id", rule.sequenceId)
      .not("crm_company_id", "is", null)
      .range(from, from + 999);
    if (error) throw new Error(`Failed to read enrollments: ${error.message}`);
    for (const r of data ?? []) enrolledEver.add(r.crm_company_id as string);
    if ((data ?? []).length < 1000) break;
  }

  // Page through matches collecting only enrollable accounts, so the cap counts
  // accounts that will actually be contacted. Taking the first page and letting
  // enrollFromCrm skip most of it burns the cap on accounts already sequenced
  // and the rule never advances past its first run.
  const PAGE = Math.max(rule.maxPerRun * 5, 50);
  const MAX_PAGES = 20; // bounded: a filter matching thousands is a mistake to see, not to serve
  const targets: string[] = [];
  let matched = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await listCompanies(client, {
      ...rule.filters,
      limit: PAGE,
      offset: page * PAGE,
    });
    matched += batch.length;
    for (const c of batch) {
      if (enrolledEver.has(c.id)) continue;
      if (targets.length < rule.maxPerRun) targets.push(c.id);
    }
    if (batch.length < PAGE) break;
    if (targets.length >= rule.maxPerRun) break;
  }

  if (dryRun) {
    return {
      ruleId: rule.id,
      matched,
      attempted: targets.length,
      enrolled: 0,
      skipped: 0,
      errors: [],
      dryRun: true,
    };
  }
  if (targets.length === 0) {
    // Nothing new to do. Recording the run keeps "it ran and found nobody"
    // distinguishable from "it never ran".
    const run: AutoEnrollRunResult = {
      ruleId: rule.id,
      matched,
      attempted: 0,
      enrolled: 0,
      skipped: 0,
      errors: [],
      dryRun: false,
    };
    await client
      .from("outreach_auto_enroll_rules")
      .update({ last_run_at: new Date().toISOString(), last_result: run })
      .eq("id", rule.id);
    return run;
  }

  const result = await enrollFromCrm(client, {
    sequenceId: rule.sequenceId,
    companyIds: targets,
    enrolledByEmail: rule.createdBy ?? null,
    allContacts: rule.allContacts,
  });

  const run: AutoEnrollRunResult = {
    ruleId: rule.id,
    matched,
    attempted: targets.length,
    enrolled: result.enrolled,
    skipped: result.skipped,
    errors: result.errors.slice(0, 20),
    dryRun: false,
  };

  await client
    .from("outreach_auto_enroll_rules")
    .update({ last_run_at: new Date().toISOString(), last_result: run })
    .eq("id", rule.id);

  return run;
}

/** Every active rule, one after another. Called by the cron. */
export async function runAllAutoEnrollRules(
  client: SupabaseClient,
): Promise<{ rules: number; enrolled: number; results: AutoEnrollRunResult[] }> {
  const { data, error } = await client
    .from("outreach_auto_enroll_rules")
    .select("*")
    .eq("active", true);
  if (error) throw new Error(`Failed to load auto-enroll rules: ${error.message}`);

  const results: AutoEnrollRunResult[] = [];
  for (const row of data ?? []) {
    const rule = rowToRule(row as RuleRow);
    try {
      results.push(await runAutoEnrollRule(client, rule));
    } catch (err) {
      results.push({
        ruleId: rule.id,
        matched: 0,
        attempted: 0,
        enrolled: 0,
        skipped: 0,
        errors: [err instanceof Error ? err.message : "failed"],
        dryRun: false,
      });
    }
  }
  return {
    rules: results.length,
    enrolled: results.reduce((n, r) => n + r.enrolled, 0),
    results,
  };
}
