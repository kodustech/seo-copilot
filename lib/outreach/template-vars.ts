/**
 * The {{token}} catalog for sequence copy.
 *
 * One list, three consumers: the renderer (what a token resolves to), the AI
 * tool descriptions (what the agent is allowed to write), and the sequence
 * editor (what a human sees while writing). They used to disagree — the agent
 * only knew about the six contact tokens, so when copy needed a signup date it
 * wrote a literal "[DATE]" and that shipped.
 *
 * Product-signal values are frozen onto the enrollment at enroll time
 * (outreach_enrollments.template_vars). Dates are frozen as ISO; everything
 * relative to "now" (days_since_signup, trial_days_left) is derived at render
 * time from those, so a task that sat in the queue for a week does not send a
 * day count that was true when it was created.
 */

export type TemplateVarSpec = {
  token: string;
  description: string;
  /** Where the value comes from — shown in the editor so it is obvious which
   *  tokens only exist on CRM-sourced enrollments. */
  source: "contact" | "product";
};

export const CONTACT_TEMPLATE_VARS: TemplateVarSpec[] = [
  { token: "first_name", description: "Contact first name", source: "contact" },
  { token: "full_name", description: "Contact full name", source: "contact" },
  { token: "company", description: "Account name", source: "contact" },
  { token: "domain", description: "Company domain", source: "contact" },
  { token: "role", description: "Contact job title", source: "contact" },
  { token: "email", description: "Contact email", source: "contact" },
  { token: "linkedin", description: "Contact LinkedIn URL", source: "contact" },
];

/** Only on enrollments created from a CRM account with an org_id. */
export const PRODUCT_TEMPLATE_VARS: TemplateVarSpec[] = [
  { token: "tier", description: "t0 | t1 | t2 | t3 | customer", source: "product" },
  { token: "trigger", description: "cloud_trial | free_limit | broken_activation | …", source: "product" },
  { token: "skip_reason", description: "Most frequent review skip reason, last 30d", source: "product" },
  { token: "signup_date", description: 'Signup date, e.g. "February 12, 2026"', source: "product" },
  { token: "days_since_signup", description: "Whole days since signup", source: "product" },
  { token: "trial_end_date", description: "Trial end date", source: "product" },
  { token: "trial_days_left", description: "Days until trial ends (unset once it has ended)", source: "product" },
  { token: "plan", description: "free_byok | teams_* | enterprise_*", source: "product" },
  { token: "subscription_status", description: "active | trial | expired | canceled", source: "product" },
  { token: "connected_git", description: '"yes" or "no" — repository connected', source: "product" },
  { token: "dev_count", description: "Git-derived engineering headcount (never seats)", source: "product" },
  { token: "seats_total", description: "Licenses on the plan", source: "product" },
  { token: "seats_used", description: "Licenses assigned", source: "product" },
  { token: "seat_usage_pct", description: 'Assigned / total, e.g. "40%"', source: "product" },
  { token: "reviews_7d", description: "Successful reviews, last 7 days", source: "product" },
  { token: "reviews_30d", description: "Successful reviews, last 30 days", source: "product" },
  { token: "skips_30d", description: "Skipped reviews, last 30 days", source: "product" },
  { token: "last_review_date", description: "Date of the last review", source: "product" },
  { token: "days_since_last_review", description: "Whole days since the last review", source: "product" },
  { token: "prs_reviewed_30d", description: "Distinct PRs reviewed, last 30 days (not reviews_30d, which counts re-reviews)", source: "product" },
  { token: "suggestions_30d", description: "Suggestions delivered to developers, last 30 days", source: "product" },
  { token: "suggestions_applied_30d", description: "Suggestions applied — implemented plus partially implemented", source: "product" },
  { token: "suggestions_implemented_30d", description: "Suggestions fully implemented (stricter than applied)", source: "product" },
  { token: "suggestions_applied_pct", description: 'Applied / delivered, e.g. "17%" (unset when nothing was delivered)', source: "product" },
];

export const ALL_TEMPLATE_VARS: TemplateVarSpec[] = [
  ...CONTACT_TEMPLATE_VARS,
  ...PRODUCT_TEMPLATE_VARS,
];

/** One-line token list for AI tool descriptions and prompts. */
export const TEMPLATE_TOKEN_HELP = [
  "Tokens: ",
  ALL_TEMPLATE_VARS.map((v) => `{{${v.token}}}`).join(" "),
  ". Product tokens (tier … suggestions_applied_pct) only resolve on CRM enrollments;",
  " a token with no value blocks the send instead of leaving a hole, so never invent",
  " placeholders like [DATE] — use a token or drop the sentence.",
].join("");

const DATE_FIELDS = ["signup_at", "trial_end", "last_review_at"] as const;

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Turn the frozen raw signal values into the tokens copy actually uses.
 * Anything that cannot be computed is simply absent — the renderer treats an
 * absent token as missing and the queue refuses to send it.
 */
export function deriveSignalTokens(
  frozen: Record<string, string>,
  now: Date = new Date(),
): Record<string, string> {
  const out: Record<string, string> = {};

  const signup = parseDate(frozen.signup_at);
  if (signup) {
    out.signup_date = formatDate(signup);
    const days = wholeDaysBetween(signup, now);
    if (days >= 0) out.days_since_signup = String(days);
  }

  const trialEnd = parseDate(frozen.trial_end);
  if (trialEnd) {
    out.trial_end_date = formatDate(trialEnd);
    const left = Math.ceil((trialEnd.getTime() - now.getTime()) / 86_400_000);
    // A trial that already ended has no "days left". Leaving the token unset
    // stops "your trial ends in -9 days" from reaching a prospect.
    if (left >= 0) out.trial_days_left = String(left);
  }

  const lastReview = parseDate(frozen.last_review_at);
  if (lastReview) {
    out.last_review_date = formatDate(lastReview);
    const days = wholeDaysBetween(lastReview, now);
    if (days >= 0) out.days_since_last_review = String(days);
  }

  // "Applied" is full plus partial. They are frozen apart because they are
  // different facts and partial regularly outnumbers full, but no email has
  // ever wanted to name them separately in the same breath.
  const implemented = Number(frozen.suggestions_implemented_30d);
  const partial = Number(frozen.suggestions_partial_30d);
  const delivered = Number(frozen.suggestions_30d);
  // Both tokens need something delivered. With nothing sent, "applied 0" is
  // true of nothing and "0%" is worse — an account we never sent a suggestion
  // to has not ignored us, and that is the one sentence that must not go out.
  //
  // A real zero still renders: broken-activation copy ("we left 40 suggestions,
  // your team applied 0") has delivered = 40 and passes this gate untouched.
  // That case was the whole reason for emitting a zero at all.
  if (
    Number.isFinite(implemented) &&
    Number.isFinite(partial) &&
    Number.isFinite(delivered) &&
    delivered > 0
  ) {
    const applied = implemented + partial;
    out.suggestions_applied_30d = String(applied);
    out.suggestions_applied_pct = `${Math.round((applied / delivered) * 100)}%`;
  }

  const total = Number(frozen.seats_total);
  const used = Number(frozen.seats_used);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) {
    out.seat_usage_pct = `${Math.round((used / total) * 100)}%`;
  }

  return out;
}

/** Columns the enroll path reads from product_signals_latest. */
export const PRODUCT_SIGNAL_COLUMNS =
  "tier,trigger,top_skip_reason,dev_count,reviews_7d,reviews_30d,skips_30d," +
  "signup_at,trial_end,last_review_at,plan_type,subscription_status," +
  "connected_git,total_licenses,assigned_licenses," +
  "prs_reviewed_30d,suggestions_30d,suggestions_implemented_30d,suggestions_partial_30d";

/**
 * Freeze a product-signals row into template_vars. Raw values only: dates stay
 * ISO and are formatted at render time, so one frozen field can back both
 * {{signup_date}} and {{days_since_signup}}.
 */
export function freezeSignalVars(
  sig: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    const s = String(value).trim();
    if (s) out[key] = s;
  };

  put("tier", sig.tier);
  put("trigger", sig.trigger);
  // dev_count is the git-derived team size, never user_count: that is Kodus
  // seats, usually 1, and it used to go out in real emails as if it were the
  // prospect's engineering headcount.
  put("dev_count", sig.dev_count);
  put("reviews_7d", sig.reviews_7d);
  put("reviews_30d", sig.reviews_30d);
  put("skips_30d", sig.skips_30d);
  put("prs_reviewed_30d", sig.prs_reviewed_30d);
  put("suggestions_30d", sig.suggestions_30d);
  put("suggestions_implemented_30d", sig.suggestions_implemented_30d);
  put("suggestions_partial_30d", sig.suggestions_partial_30d);
  put("plan", sig.plan_type);
  put("subscription_status", sig.subscription_status);
  put("seats_total", sig.total_licenses);
  put("seats_used", sig.assigned_licenses);
  if (sig.connected_git !== null && sig.connected_git !== undefined) {
    out.connected_git = sig.connected_git ? "yes" : "no";
  }
  for (const field of DATE_FIELDS) {
    const d = parseDate(
      sig[field] === null || sig[field] === undefined
        ? undefined
        : String(sig[field]),
    );
    if (d) out[field] = d.toISOString();
  }

  return out;
}
