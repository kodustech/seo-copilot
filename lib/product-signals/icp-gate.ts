import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCompanyDetails,
  getEmployeeCount,
  ninjapearEnabled,
} from "@/lib/ninjapear";

import type { CollectedOrg } from "./collect";
import { resolveDevCount, type DevCountSource } from "./classify";
import { classifyDomain } from "./domains";

// ---------------------------------------------------------------------------
// Does this product org deserve a CRM account?
//
// Two regimes, because the two populations expose completely different data:
//
//   connected git (t0/t1) → we know the real engineering team size
//                           (code_host_member_count, or PR authors as fallback)
//                           and gate on MIN_DEVS.
//   never connected (t2)  → no team-size signal exists and none ever will:
//                           code_host_member_count is written at onboarding,
//                           which requires connecting git. So we buy
//                           firmographics and gate on MIN_EMPLOYEES, then on
//                           company_type (a university is not a lead).
//
// The two thresholds are deliberately different numbers for different units.
// MIN_DEVS counts developers; MIN_EMPLOYEES counts total headcount, which
// includes everyone who never touches a repo. Setting them equal would make
// the t2 bar far weaker than the t0/t1 bar, not equal to it.
//
// Source of truth for the profile itself is growth/context/market/icp.md
// (primary ICP: 50–500+ developers) and its outbound mini-playbook, which
// reserves a 20% quota for 15–50 developer companies "when a strong behavioral
// signal exists" and calls t2 "clear ICP only". A cron cannot judge a
// behavioral signal or hold a quota, so these constants encode the mechanical
// part and leave the judgement calls to the human queue.
// ---------------------------------------------------------------------------

/** t0/t1: minimum developers on the connected git org. */
export const MIN_DEVS = 15;

/** t2: minimum total employees from firmographics. Higher than MIN_DEVS
 *  because headcount is a weaker proxy than developer count. */
export const MIN_EMPLOYEES = 50;

/** Tiers the playbook actively works. t3 stays signals-only: reactivation
 *  lists are curated by a human, not mass-imported. */
export const CRM_CREATE_TIERS = new Set(["t0", "t1", "t2"]);

/** Re-fetch firmographics after this long. Company size moves slowly and each
 *  lookup costs credits. */
const ENRICHMENT_TTL_DAYS = 180;

/**
 * Firmographics that mean "school, not a company we sell to".
 *
 * This exists because domains.ts cannot see universities that do not advertise
 * themselves in the domain: esprit.tn is a Tunisian engineering school and
 * matches none of ACADEMIC_PATTERNS, so it reached the gate as "corporate",
 * cleared MIN_EMPLOYEES on its 750 headcount, and became a lead whose "company"
 * was one student's auto-generated org. No regex over domains will win that
 * race; the firmographics already say what the place is.
 *
 * The signal is `industry`, a GICS code — 25302010 is Education Services.
 * NOT company_type: NinjaPear returns PRIVATELY_HELD for esprit.tn, which is
 * true (it is a private school) and useless here, because company_type
 * describes ownership structure, not what the organisation does. company_type
 * is still checked as a cheap second net for providers that do say EDUCATIONAL.
 *
 * Known cost: GICS puts edtech vendors in the same bucket as the schools they
 * sell to (codequotient.com, swivl.com). Rejecting them is deliberate — this
 * gate only decides whether a *never-connected* signup becomes a lead, and an
 * education-services org that never connected a repo is far more likely a
 * student than a buyer. One that is real will come back through t0/t1 once it
 * connects git, where the dev count gates it properly.
 */
const EDUCATION_GICS = new Set(["25302010"]);
const INSTITUTION_COMPANY_TYPES = ["educat", "school", "university", "college"];

export type Firmographics = {
  companyType: string | null;
  /** GICS sub-industry code, as stored (string). */
  industry: string | null;
};

function isInstitution(f: Firmographics | null | undefined): boolean {
  if (!f) return false;
  if (f.industry && EDUCATION_GICS.has(f.industry.trim())) return true;
  const t = f.companyType?.toLowerCase() ?? "";
  return t !== "" && INSTITUTION_COMPANY_TYPES.some((needle) => t.includes(needle));
}

export type GateDecision = {
  create: boolean;
  /** Machine-readable reason, stored on the account and in the sweep summary. */
  reason:
    | "no_domain"
    | "domain_free_mail"
    | "domain_academic"
    | "domain_internal"
    | "tier_not_worked"
    | "below_min_devs"
    | "no_team_signal"
    | "enrichment_unavailable"
    | "enrichment_failed"
    | "below_min_employees"
    | "institution_not_company"
    | "pass_devs"
    | "pass_employees";
  devCount: number | null;
  devCountSource: DevCountSource;
  employeeCount: number | null;
};

type EnrichmentRow = {
  domain: string;
  employee_count: number | null;
  industry: string | null;
  country: string | null;
  error: string | null;
  fetched_at: string;
};

function isFresh(fetchedAt: string, now: Date): boolean {
  const t = new Date(fetchedAt).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < ENRICHMENT_TTL_DAYS * 86_400_000;
}

/**
 * Employee count for a domain, cached in company_enrichment. 2 credits on a
 * miss; free on a hit.
 *
 * Deliberately NOT getCompanyDetails, even though details also carries an
 * employee_count field: that field comes back null for companies the dedicated
 * endpoint answers fine (fretebras.com.br → details null, employee-count 819),
 * so gating on details would reject real ICP companies as "no data". Details is
 * richer but is only worth buying once an org has already cleared the headcount
 * bar, which is where it settles the last question — see getFirmographics.
 *
 * Failures and unknown counts are cached as rows with `error` set: otherwise a
 * domain NinjaPear cannot resolve gets retried, and billed, on every sweep.
 */
export async function getEnrichment(
  client: SupabaseClient,
  domain: string,
  now: Date,
): Promise<EnrichmentRow | null> {
  const { data: cached } = await client
    .from("company_enrichment")
    .select("domain,employee_count,industry,country,error,fetched_at")
    .eq("domain", domain)
    .maybeSingle();

  const row = cached as EnrichmentRow | null;
  // A cached row is usable once it has resolved either way: a count, or a
  // recorded failure. A details-only row with no count still needs the lookup.
  if (row && isFresh(row.fetched_at, now) && (row.employee_count != null || row.error)) {
    return row;
  }
  if (!ninjapearEnabled()) return null;

  let patch: Record<string, unknown>;
  try {
    const count = await getEmployeeCount(domain);
    patch = {
      domain,
      employee_count: count,
      provider: "ninjapear",
      error: count == null ? "employee_count unavailable" : null,
      fetched_at: now.toISOString(),
    };
  } catch (err) {
    patch = {
      domain,
      employee_count: null,
      provider: "ninjapear",
      error: err instanceof Error ? err.message : "enrichment failed",
      fetched_at: now.toISOString(),
    };
  }

  const { error } = await client
    .from("company_enrichment")
    .upsert(patch, { onConflict: "domain" });
  if (error) throw new Error(`enrichment cache write failed: ${error.message}`);
  return patch as unknown as EnrichmentRow;
}

/**
 * Full firmographics (industry, country, founded year, executives) — 3 credits.
 * Only called for orgs that already cleared MIN_EMPLOYEES, so the majority of
 * never-connected signups are rejected on the cheaper employee-count lookup and
 * never reach this.
 *
 * Mostly CRM decoration, with one qualification input: industry, which is how a
 * school gets caught (see EDUCATION_GICS). Returns what it ended up with —
 * cached or fresh — and null when the lookup is unavailable or failed, which
 * callers must read as "unknown", not "fine".
 */
export async function getFirmographics(
  client: SupabaseClient,
  domain: string,
  now: Date,
): Promise<Firmographics | null> {
  const { data: cached } = await client
    .from("company_enrichment")
    .select("domain,raw,company_type,industry,fetched_at")
    .eq("domain", domain)
    .maybeSingle();
  if (cached?.raw && isFresh(cached.fetched_at as string, now)) {
    return {
      companyType: (cached.company_type as string | null) ?? null,
      industry: (cached.industry as string | null) ?? null,
    };
  }
  if (!ninjapearEnabled()) return null;

  try {
    const details = await getCompanyDetails(domain);
    const primary =
      details.addresses.find((a) => a.is_primary) ?? details.addresses[0] ?? null;
    // update, not upsert: the row already exists (getEnrichment created it) and
    // employee_count on it must survive untouched.
    await client
      .from("company_enrichment")
      .update({
        industry: details.industry != null ? String(details.industry) : null,
        company_type: details.company_type,
        country: primary?.country ?? null,
        founded_year: details.founded_year,
        name: details.name,
        raw: details as unknown as Record<string, unknown>,
      })
      .eq("domain", domain);
    return {
      companyType: details.company_type,
      industry: details.industry != null ? String(details.industry) : null,
    };
  } catch {
    // Never let a decoration lookup fail the sweep.
    return null;
  }
}

/**
 * The gate. `enrich` is injected so the caller controls whether this run is
 * allowed to spend credits (the cleanup script runs it in cache-only mode).
 */
export async function evaluateOrg(
  org: CollectedOrg,
  tier: string | null,
  opts: {
    enrich: (domain: string) => Promise<EnrichmentRow | null>;
    /** Company details for the last check before admitting a never-connected
     *  org. Optional: when absent (or returning null) the institution check is
     *  skipped and the decision falls back to headcount alone. */
    firmographics?: (domain: string) => Promise<Firmographics | null>;
  },
): Promise<GateDecision> {
  const { devCount, source } = resolveDevCount(org);
  const base = { devCount, devCountSource: source, employeeCount: null };

  // Domain first, tier second. A student or personal-mail signup is not ICP at
  // any age, and checking tier first hides that: an account that aged past the
  // 90-day window into t3 would report "tier_not_worked" and never have its
  // domain looked at — so stu.cmb.ac.lk and qq.com, the very things this gate
  // exists to reject, would survive a cleanup by getting old.
  const verdict = classifyDomain(org.derivedDomain);
  if (verdict !== "corporate") {
    return {
      ...base,
      create: false,
      reason:
        verdict === "free_mail"
          ? "domain_free_mail"
          : verdict === "academic"
            ? "domain_academic"
            : verdict === "internal"
              ? "domain_internal"
              : "no_domain",
    };
  }
  const domain = org.derivedDomain as string;

  if (tier == null || !CRM_CREATE_TIERS.has(tier)) {
    return { ...base, create: false, reason: "tier_not_worked" };
  }

  // --- connected git: gate on real developer count -------------------------
  if (org.connectedGit) {
    if (devCount == null) {
      // Connected the git org but never produced a PR and predates
      // code_host_member_count. Nothing to judge on.
      return { ...base, create: false, reason: "no_team_signal" };
    }
    return devCount >= MIN_DEVS
      ? { ...base, create: true, reason: "pass_devs" }
      : { ...base, create: false, reason: "below_min_devs" };
  }

  // --- never connected git: buy firmographics ------------------------------
  const enrichment = await opts.enrich(domain);
  if (!enrichment) {
    return { ...base, create: false, reason: "enrichment_unavailable" };
  }
  if (enrichment.error || enrichment.employee_count == null) {
    return { ...base, create: false, reason: "enrichment_failed" };
  }
  const employeeCount = enrichment.employee_count;
  if (employeeCount < MIN_EMPLOYEES) {
    return { ...base, create: false, reason: "below_min_employees", employeeCount };
  }

  // Big headcount is not the same as a company. Schools clear MIN_EMPLOYEES
  // trivially, and their signups are students on a personal project — the
  // population the domain rules are supposed to catch and structurally cannot
  // when the domain gives nothing away.
  const details = await opts.firmographics?.(domain);
  if (isInstitution(details)) {
    return {
      ...base,
      create: false,
      reason: "institution_not_company",
      employeeCount,
    };
  }

  return { ...base, create: true, reason: "pass_employees", employeeCount };
}
