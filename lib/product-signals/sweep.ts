import type { SupabaseClient } from "@supabase/supabase-js";

import { createCompany, createContact, logActivity } from "@/lib/crm";

import { classifyOrg, type Classification } from "./classify";
import { collectOrgFacts, domainOfEmail, type CollectedOrg } from "./collect";

// ---------------------------------------------------------------------------
// Product-signals sweep (cron):
//   collect facts from BigQuery → classify → persist latest + transitions →
//   sync tier onto CRM accounts, creating accounts for new t0/t1/t2 orgs.
//
// Deliberately dumb: all playbook logic lives in classify.ts, all data
// shaping in collect.ts. This file only moves data and records changes.
// ---------------------------------------------------------------------------

const UPSERT_CHUNK = 400;

/** Tiers that auto-create a CRM account. t3 (older base) stays signals-only:
 *  reactivation lists are curated by a human, not mass-imported. */
const CRM_CREATE_TIERS = new Set(["t0", "t1", "t2"]);

export type SweepSummary = {
  orgs: number;
  transitions: number;
  companiesCreated: number;
  companiesLinked: number;
  tiersUpdated: number;
  contactsCreated: number;
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
      .select("id,org_id,domain,tier")
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

  let companiesCreated = 0;
  let companiesLinked = 0;
  let tiersUpdated = 0;
  let contactsCreated = 0;

  for (const { org, cls } of classified) {
    // Personal git accounts never enter the CRM.
    if (org.orgType === "user" || cls.tier == null) continue;

    try {
      let company =
        companyByOrg.get(org.orgId) ??
        (org.derivedDomain ? companyByDomain.get(org.derivedDomain) : undefined);

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

      // Create accounts only for tiers the playbook actively works, and only
      // when the org resolves to a corporate domain.
      //
      // Do NOT set dev_count from product user_count: that is Kodus seats
      // (often 1 at signup), not engineering headcount. Team size stays
      // human/ICP; product seats live on Product tab / product_signals.
      if (!company && CRM_CREATE_TIERS.has(cls.tier) && org.derivedDomain) {
        const created = await createCompany(client, {
          name: org.orgName?.trim() || org.derivedDomain,
          domain: org.derivedDomain,
          orgId: org.orgId,
          status: "lead",
          deployment: "cloud",
          source: "product",
          tags: ["product-signup"],
        });
        company = {
          id: created.id,
          org_id: org.orgId,
          domain: org.derivedDomain,
          tier: null,
        };
        companyByOrg.set(org.orgId, company);
        companyByDomain.set(org.derivedDomain, company);
        companiesCreated += 1;

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

      if (company.tier !== cls.tier) {
        const { error } = await client
          .from("crm_companies")
          .update({ tier: cls.tier })
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
    errors: errors.slice(0, 30),
  };
}
