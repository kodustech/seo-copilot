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

/** GA4 session sources that count as an AI assistant referral. */
export const LLM_SOURCES: string[] = [
  "chatgpt.com",
  "chatgpt",
  "chat.openai.com",
  "claude.ai",
  "perplexity.ai",
  "www.perplexity.ai",
  "copilot.microsoft.com",
  "gemini.google.com",
];

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
