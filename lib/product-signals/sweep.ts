import type { SupabaseClient } from "@supabase/supabase-js";

import { createCompany, createContact, logActivity } from "@/lib/crm";

import { classifyOrg, resolveDevCount, type Classification } from "./classify";
import { collectOrgFacts, domainOfEmail, type CollectedOrg } from "./collect";
import { evaluateOrg, getEnrichment, getFirmographics } from "./icp-gate";

// ---------------------------------------------------------------------------
// Product-signals sweep (cron):
//   collect facts from BigQuery → classify → persist latest + transitions →
//   sync tier onto CRM accounts, creating accounts for new t0/t1/t2 orgs.
//
// Deliberately dumb: all playbook logic lives in classify.ts, all data
// shaping in collect.ts. This file only moves data and records changes.
// ---------------------------------------------------------------------------

const UPSERT_CHUNK = 400;

/** Tier priority when several product orgs map to the same CRM account. Higher
 *  wins: the account should carry the most urgent signal among its orgs.
 *
 *  `customer` outranks every lead tier and is not a typo. A paying org sharing
 *  a domain with a free one must keep the account marked customer — losing the
 *  election would let the free sibling's tier overwrite it and put a paying
 *  account back into the outbound queue. */
const TIER_RANK: Record<string, number> = {
  customer: 5,
  t0: 4,
  t1: 3,
  t2: 2,
  t3: 1,
};

export type SweepSummary = {
  orgs: number;
  transitions: number;
  companiesCreated: number;
  companiesLinked: number;
  tiersUpdated: number;
  contactsCreated: number;
  /** Orgs skipped for CRM sync because a sibling org owns the same account. */
  orgsSharingAccount: number;
  /** How each candidate was decided, keyed by GateDecision.reason. */
  gate: Record<string, number>;
  enrichmentCalls: number;
  errors: string[];
};

type LatestRow = {
  org_id: string;
  tier: string | null;
  trigger: string | null;
  health: string | null;
  plan_type: string | null;
  subscription_status: string | null;
};

type CompanyRef = {
  id: string;
  org_id: string | null;
  domain: string | null;
  tier: string | null;
  trigger: string | null;
  dev_count: number | null;
};

function latestRowFrom(
  org: CollectedOrg,
  cls: Classification,
  computedAt: string,
): Record<string, unknown> {
  return {
    org_id: org.orgId,
    org_name: org.orgName,
    org_type: org.orgType,
    signup_at: org.signupAt,
    connected_git: org.connectedGit,
    plan_type: org.planType,
    subscription_status: org.subscriptionStatus,
    trial_end: org.trialEnd,
    total_licenses: org.totalLicenses,
    assigned_licenses: org.assignedLicenses,
    user_count: org.userCount,
    reviews_7d: org.reviews7d,
    reviews_30d: org.reviews30d,
    last_review_at: org.lastReviewAt,
    skips_30d: org.skips30d,
    top_skip_reason: org.topSkipReason,
    tier: cls.tier,
    trigger: cls.trigger,
    health: cls.health,
    code_host_member_count: org.codeHostMemberCount,
    code_host_member_count_at: org.codeHostMemberCountAt,
    pr_author_count: org.prAuthorCount,
    dev_count: resolveDevCount(org).devCount,
    dev_count_source: resolveDevCount(org).source,
    computed_at: computedAt,
    updated_at: computedAt,
  };
}

async function fetchAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const page = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await query(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}

export async function runProductSignalsSweep(
  client: SupabaseClient,
): Promise<SweepSummary> {
  const now = new Date();
  const computedAt = now.toISOString();
  const errors: string[] = [];

  const orgs = await collectOrgFacts();
  const classified = orgs.map((org) => ({ org, cls: classifyOrg(org, now) }));

  // --- previous classification, for transition detection --------------------
  const previous = await fetchAll<LatestRow>((from, to) =>
    client
      .from("product_signals_latest")
      .select("org_id,tier,trigger,health,plan_type,subscription_status")
      .range(from, to),
  );
  const prevByOrg = new Map(previous.map((r) => [r.org_id, r]));

  // --- upsert latest ---------------------------------------------------------
  const latestRows = classified.map(({ org, cls }) =>
    latestRowFrom(org, cls, computedAt),
  );
  for (let i = 0; i < latestRows.length; i += UPSERT_CHUNK) {
    const { error } = await client
      .from("product_signals_latest")
      .upsert(latestRows.slice(i, i + UPSERT_CHUNK), { onConflict: "org_id" });
    if (error) throw new Error(`latest upsert: ${error.message}`);
  }

  // --- append transitions ----------------------------------------------------
  const transitions = classified.filter(({ org, cls }) => {
    const prev = prevByOrg.get(org.orgId);
    if (!prev) return true; // first sighting is a transition from nothing
    return (
      prev.tier !== (cls.tier ?? null) ||
      prev.trigger !== (cls.trigger ?? null) ||
      prev.plan_type !== (org.planType ?? null) ||
      prev.subscription_status !== (org.subscriptionStatus ?? null)
    );
  });
  if (transitions.length > 0) {
    const historyRows = transitions.map(({ org, cls }) => ({
      org_id: org.orgId,
      tier: cls.tier,
      trigger: cls.trigger,
      health: cls.health,
      plan_type: org.planType,
      subscription_status: org.subscriptionStatus,
      prev_tier: prevByOrg.get(org.orgId)?.tier ?? null,
      prev_trigger: prevByOrg.get(org.orgId)?.trigger ?? null,
      reviews_30d: org.reviews30d,
      skips_30d: org.skips30d,
      top_skip_reason: org.topSkipReason,
      computed_at: computedAt,
    }));
    for (let i = 0; i < historyRows.length; i += UPSERT_CHUNK) {
      const { error } = await client
        .from("product_signals_history")
        .insert(historyRows.slice(i, i + UPSERT_CHUNK));
      if (error) throw new Error(`history insert: ${error.message}`);
    }
  }

  // --- sync CRM --------------------------------------------------------------
  const companies = await fetchAll<CompanyRef>((from, to) =>
    client
      .from("crm_companies")
      .select("id,org_id,domain,tier,trigger,dev_count")
      .range(from, to),
  );
  const companyByOrg = new Map(
    companies.filter((c) => c.org_id).map((c) => [c.org_id as string, c]),
  );
  const companyByDomain = new Map(
    companies
      .filter((c) => c.domain)
      .map((c) => [(c.domain as string).toLowerCase(), c]),
  );

  // --- elect one owner org per CRM account ----------------------------------
  // crm_companies has a unique index on lower(domain), so several product orgs
  // sharing a domain necessarily land on one account. Each of them used to
  // write its own tier/trigger in the same sweep and the account flapped:
  // esprit.tn — a university where every student signs up separately — logged
  // six "Product signal" activities in one day alternating t0 ↔ t2. That is not
  // a state change, it is two orgs overwriting each other.
  //
  // So only the owner org touches the CRM. It is the one with the most urgent
  // tier, then the newest signup, then the highest org id — deterministic, so
  // the owner does not change between sweeps just because BigQuery returned the
  // rows in a different order. Losers keep their own row in
  // product_signals_latest; they are hidden from outbound, not from us.
  const accountKeyFor = (org: CollectedOrg): string => {
    const linked = companyByOrg.get(org.orgId);
    const domain = linked?.domain ?? org.derivedDomain;
    if (domain) return `domain:${domain.toLowerCase()}`;
    return linked ? `company:${linked.id}` : `org:${org.orgId}`;
  };
  type Owner = { orgId: string; rank: number; signupAt: string };
  const ownerByAccount = new Map<string, Owner>();
  for (const { org, cls } of classified) {
    if (org.orgType === "user" || cls.tier == null) continue;
    const candidate: Owner = {
      orgId: org.orgId,
      rank: TIER_RANK[cls.tier] ?? 0,
      signupAt: org.signupAt ?? "",
    };
    const key = accountKeyFor(org);
    const current = ownerByAccount.get(key);
    if (
      !current ||
      candidate.rank > current.rank ||
      (candidate.rank === current.rank &&
        (candidate.signupAt > current.signupAt ||
          (candidate.signupAt === current.signupAt &&
            candidate.orgId > current.orgId)))
    ) {
      ownerByAccount.set(key, candidate);
    }
  }

  let companiesCreated = 0;
  let companiesLinked = 0;
  let tiersUpdated = 0;
  let contactsCreated = 0;
  let enrichmentCalls = 0;
  let orgsSharingAccount = 0;
  const gate: Record<string, number> = {};

  // One enrichment per domain per sweep, even when several orgs share it.
  const enrichedThisRun = new Map<string, Awaited<ReturnType<typeof getEnrichment>>>();
  const enrich = async (domain: string) => {
    if (enrichedThisRun.has(domain)) return enrichedThisRun.get(domain)!;
    enrichmentCalls += 1;
    const result = await getEnrichment(client, domain, now);
    enrichedThisRun.set(domain, result);
    return result;
  };

  // Same, for the details lookup the gate uses to reject institutions. Only
  // reached by domains that already cleared MIN_EMPLOYEES.
  const detailsThisRun = new Map<
    string,
    Awaited<ReturnType<typeof getFirmographics>>
  >();
  const firmographics = async (domain: string) => {
    if (detailsThisRun.has(domain)) return detailsThisRun.get(domain)!;
    const result = await getFirmographics(client, domain, now);
    detailsThisRun.set(domain, result);
    return result;
  };

  for (const { org, cls } of classified) {
    // Personal git accounts never enter the CRM.
    if (org.orgType === "user" || cls.tier == null) continue;
    const isOwner = ownerByAccount.get(accountKeyFor(org))?.orgId === org.orgId;

    try {
      let company =
        companyByOrg.get(org.orgId) ??
        (org.derivedDomain ? companyByDomain.get(org.derivedDomain) : undefined);

      // A non-owner stops here once the account exists — that write is the
      // owner's. It is still allowed to CREATE one, because ownership is about
      // who maintains the tier, not about who is allowed to be a lead: the
      // top-ranked org can fail the gate (t0 with devCount < MIN_DEVS) while a
      // sibling on the same domain would pass on headcount, and suppressing it
      // would silently drop leads the sweep used to create. Whoever creates the
      // account writes the first tier; the owner takes it over from there (this
      // same sweep if it is still ahead in the loop, otherwise the next one).
      if (!isOwner && company) {
        orgsSharingAccount += 1;
        continue;
      }

      // Link a domain-matched account (e.g. created by cold research) to the org.
      if (company && !company.org_id) {
        const { error } = await client
          .from("crm_companies")
          .update({ org_id: org.orgId })
          .eq("id", company.id)
          .is("org_id", null);
        if (!error) {
          company.org_id = org.orgId;
          companyByOrg.set(org.orgId, company);
          companiesLinked += 1;
        }
      }

      // Account creation is gated on ICP fit — see icp-gate.ts for the two
      // regimes and why the thresholds differ. Orgs that fail the gate stay
      // visible in product_signals_latest for manual promotion; the sweep just
      // does not put them in front of outbound.
      //
      // dev_count comes from the git side only (code_host_member_count, else
      // PR authors). Never from user_count/licenses: those are Kodus seats
      // (often 1 at signup), which is the bug 52da752 fixed once already.
      const decision = !company
        ? await evaluateOrg(org, cls.tier, { enrich, firmographics })
        : null;
      if (decision) gate[decision.reason] = (gate[decision.reason] ?? 0) + 1;

      if (!company && decision?.create && org.derivedDomain) {
        const created = await createCompany(client, {
          name: org.orgName?.trim() || org.derivedDomain,
          domain: org.derivedDomain,
          orgId: org.orgId,
          status: "lead",
          deployment: "cloud",
          source: "product",
          devCount: decision.devCount,
          tags: ["product-signup"],
          enrichment: {
            icp_gate: decision.reason,
            dev_count_source: decision.devCountSource,
            ...(decision.employeeCount != null
              ? { employee_count: decision.employeeCount }
              : {}),
          },
        });
        company = {
          id: created.id,
          org_id: org.orgId,
          domain: org.derivedDomain,
          tier: null,
          trigger: null,
          dev_count: decision.devCount,
        };
        companyByOrg.set(org.orgId, company);
        companyByDomain.set(org.derivedDomain, company);
        companiesCreated += 1;

        // No getFirmographics call here any more: "pass_employees" now means
        // the gate already ran it (that is where the institution check lives),
        // so the row is cached and decorated by the time we get here.

        // isPrimary is per company (not sweep-wide) so each new account gets a lead contact.
        let primarySetForCompany = false;
        for (const contact of org.contacts.slice(0, 3)) {
          const corporate =
            !org.derivedDomain || domainOfEmail(contact.email) === org.derivedDomain;
          if (!corporate) continue;
          await createContact(client, company.id, {
            name: contact.name ?? contact.email.split("@")[0],
            email: contact.email,
            isPrimary: !primarySetForCompany,
          });
          primarySetForCompany = true;
          contactsCreated += 1;
        }
      }

      if (!company) continue;

      // Keep dev_count fresh on accounts that already exist — including ones
      // created by cold research before the org linked. Only ever writes a
      // git-derived number, and never overwrites a known count with null.
      const { devCount } = resolveDevCount(org);
      if (devCount != null && devCount !== company.dev_count) {
        await client
          .from("crm_companies")
          .update({ dev_count: devCount })
          .eq("id", company.id);
        company.dev_count = devCount;
      }

      // Trigger travels with tier: the playbook keys timing off one and the
      // message off the other, so a stale trigger means the right account gets
      // the wrong email.
      if (company.tier !== cls.tier || company.trigger !== cls.trigger) {
        const { error } = await client
          .from("crm_companies")
          .update({ tier: cls.tier, trigger: cls.trigger })
          .eq("id", company.id);
        // A linked product org means the account uses Cloud; fill deployment
        // only when unset so a human-set self_hosted marker survives.
        await client
          .from("crm_companies")
          .update({ deployment: "cloud" })
          .eq("id", company.id)
          .is("deployment", null);
        if (error) throw new Error(error.message);
        const from = company.tier ?? "none";
        await logActivity(client, company.id, "signal", {
          summary: `Product signal: ${from} → ${cls.tier}${cls.trigger ? ` (${cls.trigger})` : ""}`,
          meta: {
            // Which org produced the signal: an account can cover several, and
            // without this a timeline of tier changes cannot be read at all.
            org_id: org.orgId,
            tier: cls.tier,
            trigger: cls.trigger,
            health: cls.health,
            plan_type: org.planType,
            top_skip_reason: org.topSkipReason,
            reviews_30d: org.reviews30d,
          },
          touch: false,
        });
        company.tier = cls.tier;
        company.trigger = cls.trigger;
        tiersUpdated += 1;
      }
    } catch (err) {
      errors.push(
        `${org.orgName ?? org.orgId}: ${err instanceof Error ? err.message : "fail"}`,
      );
    }
  }

  return {
    orgs: classified.length,
    transitions: transitions.length,
    companiesCreated,
    companiesLinked,
    tiersUpdated,
    contactsCreated,
    orgsSharingAccount,
    gate,
    enrichmentCalls,
    errors: errors.slice(0, 30),
  };
}
