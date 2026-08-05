// ---------------------------------------------------------------------------
// Tier classifier — the outbound playbook as a pure function.
//
// Input: raw facts about one product org (collected from BigQuery).
// Output: { tier, trigger }. No I/O, no dates read from the clock (the sweep
// passes `now`), so it is trivially unit-testable and the playbook can change
// by editing this file alone.
//
// Tiers (attack order by demonstrated intent, see growth/context/growth/gtm.md):
//   t0  open decision window: in cloud trial, trial just expired, or hitting
//       the free plan limit. Deciding right now whether to pay.
//   t1  connected git in the last 90 days, outside the window. Either broken
//       activation (no review ever delivered) or healthy free usage.
//   t2  signed up recently but never connected git.
//   t3  older base: anything past the 90-day window that is not paying.
//   customer  paying — excluded from outbound, owned by the CRM status.
//   null      personal git accounts and orgs we cannot classify.
// ---------------------------------------------------------------------------

export type OrgFacts = {
  orgId: string;
  orgName: string | null;
  /** From auth_integrations authDetails.accountType: organization | user */
  orgType: "organization" | "user" | null;
  signupAt: string | null;
  connectedGit: boolean;
  planType: string | null;
  subscriptionStatus: string | null; // active | trial | expired | canceled
  trialEnd: string | null;
  totalLicenses: number | null;
  assignedLicenses: number | null;
  userCount: number | null;
  reviews7d: number;
  reviews30d: number;
  lastReviewAt: string | null;
  skips30d: number;
  topSkipReason: string | null;
  /** Members of the connected git org, persisted by kodus-ai at onboarding.
   *  Null for every org onboarded before 2026-07-28 (no backfill exists). */
  codeHostMemberCount: number | null;
  codeHostMemberCountAt: string | null;
  /** Distinct non-bot PR authors Kodus saw. Fallback when the above is null. */
  prAuthorCount: number | null;
};

export type DevCountSource = "code_host" | "pr_authors" | "none";

/**
 * Engineering team size, from the git side only.
 *
 * Never derived from licenses or user_count: those are Kodus seats (often 1 at
 * signup) and mapping them onto dev_count is the bug 52da752 fixed once already.
 * An org that never connected git has no source at all and returns "none" —
 * that is a real state, not a zero.
 */
export function resolveDevCount(facts: {
  codeHostMemberCount: number | null;
  prAuthorCount: number | null;
}): { devCount: number | null; source: DevCountSource } {
  if (facts.codeHostMemberCount != null && facts.codeHostMemberCount > 0) {
    return { devCount: facts.codeHostMemberCount, source: "code_host" };
  }
  if (facts.prAuthorCount != null && facts.prAuthorCount > 0) {
    return { devCount: facts.prAuthorCount, source: "pr_authors" };
  }
  return { devCount: null, source: "none" };
}

export type Tier = "t0" | "t1" | "t2" | "t3" | "customer" | null;

export type TierTrigger =
  // t0
  | "cloud_trial"
  | "trial_broken"
  | "trial_just_expired"
  | "free_limit"
  // t1
  | "broken_activation"
  | "healthy_usage"
  | "went_quiet"
  // t2
  | "never_connected"
  // t3
  | "older_base"
  // customer / excluded
  | "paying"
  | "personal_account"
  | null;

export type Health = "active" | "cooling" | "at_risk" | "dormant" | "unknown";

export type Classification = {
  tier: Tier;
  trigger: TierTrigger;
  health: Health;
};

/** Days after trial end during which the account still counts as t0. */
const TRIAL_GRACE_DAYS = 15;
/** Recency window separating t1/t2 from the older base (t3). */
const RECENT_DAYS = 90;

/** Skip reasons that mean "the free plan is gating this org" → t0 free_limit. */
const LIMIT_SKIP_PATTERNS = [
  /plan limit/i,
  /no active subscription/i,
  /user not licensed/i,
];

function daysBetween(fromIso: string | null, now: Date): number | null {
  if (!fromIso) return null;
  const t = new Date(fromIso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

function deriveHealth(facts: OrgFacts, now: Date): Health {
  const d = daysBetween(facts.lastReviewAt, now);
  if (d == null) return facts.connectedGit ? "dormant" : "unknown";
  if (d <= 7) return "active";
  if (d <= 30) return "cooling";
  if (d <= 60) return "at_risk";
  return "dormant";
}

function isPaying(facts: OrgFacts): boolean {
  return (
    facts.subscriptionStatus === "active" &&
    facts.planType != null &&
    facts.planType !== "free_byok"
  );
}

function hitsFreeLimit(facts: OrgFacts): boolean {
  if (facts.planType !== "free_byok") return false;
  if (!facts.topSkipReason) return false;
  return LIMIT_SKIP_PATTERNS.some((re) => re.test(facts.topSkipReason ?? ""));
}

export function classifyOrg(facts: OrgFacts, now: Date = new Date()): Classification {
  const health = deriveHealth(facts, now);

  if (facts.orgType === "user") {
    return { tier: null, trigger: "personal_account", health };
  }
  if (isPaying(facts)) {
    return { tier: "customer", trigger: "paying", health };
  }

  // --- t0: open decision window -------------------------------------------
  // Tier answers "when do we touch" (priority); trigger answers "what do we
  // say". An account in trial with nothing delivered stays t0 — the trial
  // clock is burning while the product looks broken, which makes it the most
  // urgent touch of all — but the message is rescue, not sales.
  if (facts.subscriptionStatus === "trial") {
    const ended = daysBetween(facts.trialEnd, now);
    // trialEnd in the future (negative days) or unknown → in trial.
    // Recently ended → still inside the grace window.
    if (ended == null || ended <= TRIAL_GRACE_DAYS) {
      const broken = facts.lastReviewAt == null;
      return {
        tier: "t0",
        trigger: broken
          ? "trial_broken"
          : ended != null && ended > 0
            ? "trial_just_expired"
            : "cloud_trial",
        health,
      };
    }
  }
  if (facts.subscriptionStatus === "expired") {
    const ended = daysBetween(facts.trialEnd, now);
    if (ended != null && ended >= 0 && ended <= TRIAL_GRACE_DAYS) {
      return { tier: "t0", trigger: "trial_just_expired", health };
    }
  }
  if (hitsFreeLimit(facts)) {
    return { tier: "t0", trigger: "free_limit", health };
  }

  const signupDays = daysBetween(facts.signupAt, now);
  const recent = signupDays != null && signupDays <= RECENT_DAYS;

  // --- t1: connected recently, outside the window -------------------------
  if (recent && facts.connectedGit) {
    // Skips happening with no reviews landing means the product is refusing to
    // run, and it records why. Whether the org ever reviewed before does not
    // change the message: the email names the skip reason and offers the fix.
    //
    // This used to also require lastReviewAt == null, so it only caught orgs
    // that never got a single review. An org that ran fine and then hit a
    // config wall — a BYOK key removed, automated review switched off — fell
    // through to went_quiet and read as "lost interest". Five accounts are in
    // that state right now, one of them skipping 777 times in 30 days with 42
    // developers behind it.
    // The widened path requires a recorded reason. broken_activation exists to
    // name the reason and offer the fix, so without one there is nothing to
    // send: the email would read "the reason we record is: ." collect.ts maps
    // the '(none)' placeholder back to null, and a skip can be logged with no
    // errorMessage at all, so this is reachable — just not today (0 of the 31
    // t1 orgs currently skipping without reviews).
    //
    // The original narrow case keeps firing unconditionally: an org that never
    // received a single review is broken whether or not the skip was labelled,
    // and that behaviour predates this change.
    if (
      facts.reviews30d === 0 &&
      facts.skips30d > 0 &&
      (facts.lastReviewAt == null || facts.topSkipReason != null)
    ) {
      return { tier: "t1", trigger: "broken_activation", health };
    }
    if (facts.reviews30d > 0) {
      return { tier: "t1", trigger: "healthy_usage", health };
    }
    return { tier: "t1", trigger: "went_quiet", health };
  }

  // --- t2: signed up recently, never connected ----------------------------
  if (recent && !facts.connectedGit) {
    return { tier: "t2", trigger: "never_connected", health };
  }

  // --- t3: everything older -----------------------------------------------
  return { tier: "t3", trigger: "older_base", health };
}
