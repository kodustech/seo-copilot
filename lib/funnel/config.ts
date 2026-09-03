// Funnel definitions. Every number on /funnel is derived from a source
// system; this file only holds the boundaries (which pages count as a
// qualified visit, what "ICP" means, which sequences are cold) and the
// monthly targets. Change a definition here and the whole page follows.

/** Pages whose Google clicks count as a qualified visit. */
export const QUALIFIED_PAGES: string[] = [
  "https://kodus.io/self-hosted-ai-code-review/",
  "https://kodus.io/en/coderabbit-alternative/",
  "https://kodus.io/alternativas-coderabbit/",
  "https://kodus.io/en/sonarqube-alternatives-code-quality/",
  "https://kodus.io/alternativas-sonarqube-qualidade-codigo/",
  "https://kodus.io/en/gitlab-code-review-tools/",
  "https://kodus.io/en/azure-devops-ai-code-review-tools/",
  "https://kodus.io/en/ai-code-review-tools-bitbucket/",
  "https://kodus.io/en/cursor-bugbot-alternatives/",
  "https://kodus.io/kodus-vs-coderabbit/",
  "https://kodus.io/en/graphite-alternatives/",
  "https://kodus.io/en/qodo-alternatives/",
  "https://kodus.io/en/cubic-alternatives/",
  "https://kodus.io/en/ai-code-review-tools/",
  "https://kodus.io/pricing/",
  "https://trust.kodus.io/",
  "https://docs.kodus.io/how_to_use/en/byok",
  "https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm",
];

/** Head terms watched for the platform pages (position is the lever). */
export const HEAD_TERMS: string[] = [
  "gitlab code review",
  "gitlab ai code review",
  "azure devops code review",
  "azure devops ai code review",
  "bitbucket code review",
  "bitbucket ai code review",
  "self hosted ai code review",
];

/**
 * GA4 session sources that count as an AI assistant referral, as a BigQuery
 * regex on the lowercased source. A regex because the same assistant shows up
 * under several spellings (perplexity.ai, www.perplexity.ai and a bare
 * "perplexity" from the app), and a fixed list missed the short ones.
 */
export const LLM_SOURCE_REGEX = String.raw`(^|\.)(chatgpt|openai|claude|perplexity|copilot|gemini\.google)(\.|$)`;

/**
 * Mediums an assistant referral can carry. GA4 labels them "ai-assistant"
 * (since June 2026), "referral", "organic" (when it treats the assistant as a
 * search engine), "(not set)", "(none)" or empty. Anything else is a
 * utm_medium somebody typed on a link (paid, cpc, social...), which is a
 * campaign, not an assistant sending a reader. An allowlist, because GA4
 * passes utm_medium verbatim and a denylist can never be complete.
 */
export const LLM_ALLOWED_MEDIUMS: string[] = ["", "(none)", "(not set)", "referral", "ai-assistant", "organic"];

/** Free-mail domains: a signup from one of these is not a corporate signup. */
export const FREE_MAIL_DOMAINS: string[] = [
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.com.br",
  "outlook.com",
  "outlook.com.br",
  "live.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "msn.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
];

/** ICP rule on product data. Member count 0 means "unknown", not zero. */
export const ICP_MIN_MEMBERS = 20;
export const ICP_MIN_AUTHORS = 10;

/** CRM custom field a human sets after checking the company on LinkedIn. */
export const ICP_VERIFIED_FIELD = "icp_verified";

/** CRM statuses that mean "opportunity". */
export const OPPORTUNITY_STATUSES = ["qualified", "poc", "negotiation"] as const;

/** Sequences that go to companies not yet in the product (cold outbound). */
export const COLD_SEQUENCE_PATTERNS: RegExp[] = [/^Outbound BR/i, /Leads vaga QA/i];

/** Self-hosted instance with "company usage": ≥ this many PRs reviewed in 7 d. */
export const SELF_HOSTED_MIN_PRS_7D = 5;
export const SELF_HOSTED_ACTIVE_DAYS = 14;

/** Opportunity with no activity for this many days is flagged. */
export const OPPORTUNITY_IDLE_DAYS = 14;

/**
 * Market reference bands for the arrow rates, as fractions. Inside the band
 * is normal; below is orange; above is green. `inverted` flips that (a bounce
 * rate above the band is bad). `loose` marks a rate where being far above the
 * band means the definition is loose, not that we are great.
 */
export type RateBand = { lo: number; hi: number; inverted?: boolean; loose?: boolean };
export const RATE_BANDS: Record<string, RateBand> = {
  connected: { lo: 0.4, hi: 0.6 },
  touch_48h: { lo: 1, hi: 1 },
  conv_to_opp: { lo: 0.3, hi: 0.5, loose: true },
  opp_active: { lo: 1, hi: 1 },
  cold_reply: { lo: 0.03, hi: 0.08 },
  // Cold reply → booked meeting. Outbound benchmarks put it around a third.
  reply_to_meeting: { lo: 0.25, hi: 0.4 },
  cold_bounce: { lo: 0.0, hi: 0.03, inverted: true },
  survey: { lo: 0.9, hi: 1 },
};

/** A target stage below this share of its (pro-rated) target is a bottleneck. */
export const BOTTLENECK_RATIO = 0.6;
/** How many red markers at most. The page is about the worst two, not a heatmap. */
export const MAX_BOTTLENECKS = 2;
/** Cold replies at zero with at least this many contacts is a bottleneck on its own. */
export const COLD_MIN_CONTACTS_FOR_VERDICT = 50;

/**
 * Targets are off the canvas for now: the funnel shows measured numbers only.
 * When targets come back they should be read from seo-copilot Goals, not
 * from this file. While false, TARGETS below is ignored and bottlenecks come
 * only from market bands (rates in `crit`) and the cold zero-reply rule.
 */
export const SHOW_TARGETS = false;

/** Monthly targets. null = no target set. */
export const TARGETS: Record<string, number | null> = {
  icp: 12,
  conversations: 20,
  opportunities: 8,
  closed_brl: 185_000,
  arr_brl: 1_000_000,
  ob_companies_in_conversation: 8,
  non_github_signups: 30,
};
