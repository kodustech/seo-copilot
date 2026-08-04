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
 *  through: an unknown key would silently widen the audience. */
const ALLOWED_FILTERS = [
  "status",
  "priority",
  "tier",
  "deployment",
  "source",
  "ownerEmail",
  "search",
  "staleOnly",
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

  // Ask for one more than the cap so "matched" can tell the difference between
  // "this is everyone" and "this is the first page of a much wider net".
  const companies = await listCompanies(client, {
    ...rule.filters,
    limit: rule.maxPerRun + 1,
  });
  const matched = companies.length;
  const targets = companies.slice(0, rule.maxPerRun);

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

  const result = await enrollFromCrm(client, {
    sequenceId: rule.sequenceId,
    companyIds: targets.map((c) => c.id),
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
