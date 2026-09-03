import { RATE_BANDS } from "./config";

/**
 * The funnel as a structure an agent can reason over: which stage feeds
 * which, which rate sits on each edge, what moves each stage, and how to
 * read the numbers. No verdicts live here: the page shows measured numbers
 * and market bands, and the reader (human or agent) decides what the
 * bottleneck is. This file gives the agent the same picture the canvas gives
 * a person.
 */

export type FunnelLane = { id: string; title: string; stages: string[]; note: string };

export const FUNNEL_LANES: FunnelLane[] = [
  {
    id: "self_hosted",
    title: "Self-hosted",
    stages: ["sh_instances", "sh_trial"],
    note: "Companies that run Kodus on their own infrastructure. Anonymous telemetry shows usage; a trial request is the only moment they identify themselves.",
  },
  {
    id: "inbound",
    title: "Inbound (Cloud)",
    stages: ["impressions", "visits", "llm_referral", "signups", "icp"],
    note: "Google impressions on the 18 intent pages become clicks, clicks and other sources become corporate signups, and a few signups are ICP-sized teams (20+ members or 10+ PR authors).",
  },
  {
    id: "outbound",
    title: "Outbound (cold)",
    stages: ["ob_contacts", "ob_replies"],
    note: "People enrolled in cold sequences (email and LinkedIn) at companies not in the product, and the human replies they send back.",
  },
  {
    id: "commercial",
    title: "Commercial",
    stages: ["conversations", "meetings", "opportunities", "closed", "self_serve", "arr"],
    note: "The CRM band every entry lane feeds. A meeting is optional (a side stage), not a mandatory step. Self-serve is the path where a signup pays without a conversation.",
  },
];

export type FunnelEdge = {
  from: string;
  to: string;
  /** Rate id on this edge, when the funnel measures one. */
  rate?: string;
  note?: string;
};

export const FUNNEL_EDGES: FunnelEdge[] = [
  { from: "impressions", to: "visits", rate: "ctr" },
  { from: "visits", to: "signups", rate: "visit_to_signup", note: "Not measured: signups do not carry their landing page, and signups come from every source." },
  { from: "llm_referral", to: "signups", note: "Not measured as a rate; LLM referral is a floor (app clicks arrive as direct traffic)." },
  { from: "signups", to: "icp", rate: "icp_share", note: "Also 'connected' (share that connects a git) and 'survey' (share answering the referral survey)." },
  { from: "icp", to: "conversations", rate: "touch_48h", note: "A human touch within 48 h of signup is the lever that turns an ICP signup into a conversation." },
  { from: "sh_instances", to: "sh_trial" },
  { from: "sh_trial", to: "conversations" },
  { from: "ob_contacts", to: "ob_replies", rate: "cold_reply", note: "'cold_bounce' is the inverted rate on the same edge (email bounces)." },
  { from: "ob_replies", to: "conversations", rate: "reply_to_conversation" },
  { from: "conversations", to: "meetings", rate: "conv_to_meeting", note: "Optional path." },
  { from: "conversations", to: "opportunities", rate: "conv_to_opp" },
  { from: "meetings", to: "opportunities", rate: "meeting_to_opp" },
  { from: "ob_replies", to: "meetings", rate: "reply_to_meeting", note: "Cold reply to booked meeting; the cold-specific view of the commercial band." },
  { from: "ob_replies", to: "opportunities", rate: "reply_to_opp" },
  { from: "opportunities", to: "closed", note: "Win rate is not computed as a rate yet; 'opp_active' is the share of open opportunities with recent activity." },
  { from: "signups", to: "self_serve", note: "Paid without a conversation, from billing." },
  { from: "self_serve", to: "closed" },
];

/**
 * What moves each stage, in one line. Mechanics, not advice: the agent
 * combines these with the numbers to find where effort pays.
 */
export const STAGE_MECHANICS: Record<string, string> = {
  impressions: "Google impressions on the 18 qualified intent pages. Moves with rankings, new pages for buyer queries, and query demand. Slow (weeks).",
  visits: "Clicks on those pages = impressions × CTR. CTR moves with position and title/snippet; volume moves with impressions.",
  llm_referral: "Users arriving from ChatGPT, Claude, Perplexity, Copilot, Gemini. Moves with being cited in assistant answers (see AI visibility). A floor: app clicks land in direct.",
  signups: "Corporate-email signups in the period, all sources. Moves with visits, brand demand, and how much the site asks for the signup.",
  connected: "Signups that connected a git provider. Moves with onboarding friction and platform coverage (GitLab, Azure, Bitbucket are 6% of signups and 45% of ICP).",
  icp: "Signups from teams of 20+ members or 10+ PR authors. Moves with where traffic comes from (platform pages and comparison pages bring larger teams) and with outbound landing on the product.",
  sh_instances: "Self-hosted instances whose first heartbeat fell in the period and that reached company-sized usage. Moves with docs, GitHub, and the self-hosted pages; anonymous until they ask for a trial.",
  sh_trial: "Self-hosted trial requests (hand raised). Moves with the trial CTA in the product and docs, and with the value of the gated features.",
  sh_found: "Self-hosted instances identified (PostHog or by hand) and added to the CRM. Manual today.",
  ob_contacts: "People enrolled in cold sequences. Moves with list building and sending capacity; only the entry volume, not quality.",
  ob_replies: "Human replies to cold sequences (bounces and autoresponders excluded), dated by the reply. Moves with list fit, message, and channel (August: all replies came via LinkedIn, none via email).",
  conversations: "CRM accounts that entered 'engaged' in the period (first time). Fed by ICP signups touched in time, self-hosted trials, outbound replies, and network. The band where every lane meets.",
  meetings: "Accounts that reached 'meeting' (calendar-synced). Optional stage: an account can go to opportunity without one.",
  opportunities: "Accounts that entered qualified, poc or negotiation in the period. Moves with conversation quality and follow-up cadence (the reply → meeting step is where cold stalled in August).",
  closed: "Accounts that became customers in the period, with the ARR they carry. Moves with opportunities and win rate; the arr field must be filled on the account.",
  self_serve: "Organizations whose first paid license was assigned in the period without a CRM conversation. Moves with product gates and pricing clarity, not with sales effort.",
  arr: "Sum of arr on customer accounts as the CRM sees it (a stock, not a flow). Depends on the field being filled.",
};

export const FUNNEL_GUIDE = [
  "Read it as three entry lanes (self-hosted, inbound cloud, outbound cold) feeding one commercial band (conversations → opportunities → closed). Meetings are a side stage, not a mandatory step. Self-serve is a fourth path: signup → paid without a conversation.",
  "Every stage is a flow of the period (what entered it between periodStart and periodEnd) except 'arr', which is a stock. Compare stages of the same period; compare a period with the previous one using comparison.previous.",
  "Rates carry a market band {lo, hi}: status 'good' above the band, 'ok' inside, 'warn' below, 'crit' far below (or far above for inverted bands like bounce). 'na' means not measured. Bands are benchmarks, not targets; targets come from goals bound to a stage.",
  "A stage with value null is not measured yet (the definition says why). A rate with value null has no denominator or no data. Do not treat null as zero.",
  "For an open period, elapsedShare says how much of it has passed; pro-rate goals by it before calling a stage behind.",
  "Small numbers are noisy: a rate on fewer than ~30 in the denominator says little. Say so instead of ranking it.",
  "To find where effort pays: walk each lane from entry to conversations, find the edge where the most volume is lost relative to its band, then check whether the stage before it has enough volume for the fix to matter. The lane with volume and a weak edge beats the lane with a great rate on nothing.",
  "Caveats: LLM referral is a floor (app clicks arrive as direct). Self-hosted telemetry is anonymous and started 2026-07-03. Outbound replies are counted by reply date, so a week's replies may come from the previous batch. Bounces are excluded from replies.",
].join(" ");

/** Rate bands with their meaning, for the agent. */
export function rateBandTable(): Array<{ id: string; lo: number; hi: number; inverted: boolean; loose: boolean }> {
  return Object.entries(RATE_BANDS).map(([id, b]) => ({ id, lo: b.lo, hi: b.hi, inverted: Boolean(b.inverted), loose: Boolean(b.loose) }));
}

/** The period right before a spec: previous month, or a range of the same length ending the day before. */
export function previousPeriodSpec(spec: string): string {
  const month = spec.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    const prev = new Date(Date.UTC(y, m - 2, 1));
    return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const range = spec.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (!range) throw new Error(`Invalid period '${spec}'`);
  const start = new Date(`${range[1]}T00:00:00Z`).getTime();
  const end = new Date(`${range[2]}T00:00:00Z`).getTime();
  const days = Math.round((end - start) / 86_400_000) + 1;
  const prevEnd = start - 86_400_000;
  const prevStart = prevEnd - (days - 1) * 86_400_000;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return `${iso(prevStart)}..${iso(prevEnd)}`;
}

/** Stages upstream and downstream of a stage, from the edges. */
export function stageLinks(stageId: string): { fedBy: string[]; feeds: string[] } {
  return {
    fedBy: FUNNEL_EDGES.filter((e) => e.to === stageId).map((e) => e.from),
    feeds: FUNNEL_EDGES.filter((e) => e.from === stageId).map((e) => e.to),
  };
}
