import type { SupabaseClient } from "@supabase/supabase-js";

import { getVisibilitySummary, ENGINE_LABEL, type AiEngine, AI_ENGINES } from "@/lib/ai-visibility";
import { getBet, type Bet, type BetMeasure } from "@/lib/bets";
import { previousPeriodSpec } from "@/lib/funnel/graph";
import { FUNNEL_METRICS } from "@/lib/funnel/goals";
import { fetchFunnel, type FunnelData } from "@/lib/funnel/metrics";
import { GOAL_DONE_STAGES } from "@/lib/goals";

/**
 * Reading a bet the way the follow-up asks: was the action executed, did
 * the metric it names move past its threshold, and did the movement reach
 * opportunities. Every number here comes from a system (funnel, AI
 * visibility, sequences, Kanban), so an agent can answer "did this
 * hypothesis hold" with one call and cite where the number came from.
 */

export type EvaluationLevel = {
  label: string;
  status: "yes" | "no" | "partial" | "unknown";
  detail: string;
};

export type BetEvaluation = {
  betId: string;
  measure: BetMeasure | null;
  window: { start: string; end: string; effectiveEnd: string; elapsedShare: number };
  previousWindow: { start: string; end: string } | null;
  /** The measured number now, its previous-window counterpart, the threshold. */
  current: number | null;
  previous: number | null;
  threshold: number | null;
  comparator: ">=" | "<=" | null;
  /** Threshold met on the current number. Null when not measurable. */
  met: boolean | null;
  /** current / threshold for ">=" goals (capped at 1); null otherwise. */
  progress: number | null;
  daysLeft: number;
  /** Where the number came from, one line. */
  source: string;
  /** Human-readable "23 replies (window 2026-09-01 to 2026-09-14), threshold ≥ 30". */
  display: string;
  levels: { action: EvaluationLevel; metric: EvaluationLevel; opportunities: EvaluationLevel };
  /** What the evidence supports, for the verdict field. Not a decision. */
  suggestedVerdict: string;
  errors: string[];
};

const DAY = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtValue(v: number | null, isRate: boolean): string {
  if (v == null) return "–";
  return isRate ? `${Math.round(v * 1000) / 10}%` : Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function compare(current: number | null, comparator: ">=" | "<=", threshold: number): boolean | null {
  if (current == null) return null;
  return comparator === ">=" ? current >= threshold : current <= threshold;
}

const RATE_KINDS = new Set(["funnel_rate", "ai_share"]);

function isRateMeasure(m: BetMeasure): boolean {
  return RATE_KINDS.has(m.kind) || (m.kind === "outbound_tag" && m.submetric === "reply_rate");
}

/** Rates arrive as fractions; a threshold typed as "3" for a rate means 3%. */
function normalizeThreshold(m: BetMeasure): number {
  return isRateMeasure(m) && m.threshold > 1 ? m.threshold / 100 : m.threshold;
}

// Funnel results per spec, for one evaluation batch (a page load evaluates
// every bet; most share windows).
type FunnelCache = Map<string, Promise<FunnelData>>;

function funnelFor(client: SupabaseClient, cache: FunnelCache, spec: string): Promise<FunnelData> {
  let p = cache.get(spec);
  if (!p) {
    p = fetchFunnel(client, spec);
    cache.set(spec, p);
  }
  return p;
}

async function outboundTagNumbers(
  client: SupabaseClient,
  tag: string,
  start: string,
  endExclusive: string,
): Promise<{ contacts: number; replies: number; meetings: number; sequences: string[] }> {
  const { data: seqs, error } = await client.from("outreach_sequences").select("id,name,tags").contains("tags", [tag]);
  if (error) throw new Error(`outreach_sequences: ${error.message}`);
  const ids = (seqs ?? []).map((s) => String(s.id));
  if (ids.length === 0) return { contacts: 0, replies: 0, meetings: 0, sequences: [] };
  // Paged, so a big campaign window never gets silently truncated.
  const rows: Array<{ id: string; status: string; crm_company_id: string | null; created_at: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data: enr, error: enrErr } = await client
      .from("outreach_enrollments")
      .select("id,status,crm_company_id,created_at")
      .in("sequence_id", ids)
      .gte("created_at", `${start}T00:00:00Z`)
      .lt("created_at", `${endExclusive}T00:00:00Z`)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (enrErr) throw new Error(`outreach_enrollments: ${enrErr.message}`);
    const page = (enr ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const replied = rows.filter((r) => r.status === "replied");
  // A meeting counts when the enrolled company moved to `meeting` after the
  // enrollment started (the calendar sync writes that status).
  const companyIds = [...new Set(rows.map((r) => r.crm_company_id).filter((v): v is string => Boolean(v)))];
  let meetings = 0;
  if (companyIds.length) {
    const startedAt = new Map<string, string>();
    for (const r of rows) if (r.crm_company_id) startedAt.set(String(r.crm_company_id), String(r.created_at));
    // Bounded to the window on both ends, so the same meeting cannot count
    // for this window and the one before.
    const { data: acts } = await client
      .from("crm_activities")
      .select("company_id,created_at,meta")
      .eq("kind", "status_change")
      .in("company_id", companyIds)
      .gte("created_at", `${start}T00:00:00Z`)
      .lt("created_at", `${endExclusive}T00:00:00Z`)
      .order("created_at", { ascending: true })
      .limit(5000);
    const seen = new Set<string>();
    for (const a of acts ?? []) {
      const meta = (a.meta ?? {}) as { to?: string };
      const cid = String(a.company_id);
      if (meta.to === "meeting" && String(a.created_at) >= (startedAt.get(cid) ?? "") && !seen.has(cid)) {
        seen.add(cid);
        meetings += 1;
      }
    }
  }
  return { contacts: rows.length, replies: replied.length, meetings, sequences: (seqs ?? []).map((s) => String(s.name)) };
}

async function actionLevel(client: SupabaseClient, bet: Bet): Promise<EvaluationLevel> {
  if (bet.actionDoneAt) return { label: "Action executed", status: "yes", detail: `Marked done ${bet.actionDoneAt.slice(0, 10)}.` };
  if (bet.kanbanItemId) {
    const { data } = await client.from("growth_work_items").select("id,title,stage").eq("id", bet.kanbanItemId).maybeSingle();
    if (data) {
      const done = Boolean(data.stage) && GOAL_DONE_STAGES.has(String(data.stage));
      return {
        label: "Action executed",
        status: done ? "yes" : "partial",
        detail: `Kanban card "${String(data.title)}" is in ${data.stage ?? "no stage"}.`,
      };
    }
  }
  if (bet.status === "queued") return { label: "Action executed", status: "no", detail: "Bet has not started." };
  return { label: "Action executed", status: "unknown", detail: "No Kanban card linked and no done date; mark it by hand." };
}

export async function evaluateBet(client: SupabaseClient, betOrId: Bet | string, cache: FunnelCache = new Map()): Promise<BetEvaluation> {
  const bet = typeof betOrId === "string" ? await getBet(client, betOrId) : betOrId;
  if (!bet) throw new Error("Bet not found");
  const errors: string[] = [];
  const today = iso(new Date());
  const start = bet.measure?.window?.start ?? bet.createdAt.slice(0, 10);
  const end = bet.measure?.window?.end ?? bet.decisionAt;
  const effectiveEnd = end < today ? end : today;
  const totalDays = Math.max(1, Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / DAY) + 1);
  const elapsedDays = Math.max(0, Math.min(totalDays, Math.round((new Date(`${effectiveEnd}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / DAY) + 1));
  const daysLeft = Math.max(0, Math.round((new Date(`${bet.decisionAt}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY));
  const spec = `${start}..${effectiveEnd}`;
  const prevSpec = previousPeriodSpec(spec);
  const [prevStart, prevEnd] = prevSpec.split("..");

  let current: number | null = null;
  let previous: number | null = null;
  let source = "";
  let opportunities: EvaluationLevel = { label: "Reached opportunities", status: "unknown", detail: "Funnel not read." };

  // Opportunities in the window vs the window before, for every kind.
  try {
    const [f, p] = await Promise.all([funnelFor(client, cache, spec), funnelFor(client, cache, prevSpec)]);
    const now = f.nodes.opportunities?.value ?? null;
    const before = p.nodes.opportunities?.value ?? null;
    opportunities = {
      label: "Reached opportunities",
      status: now == null ? "unknown" : before != null && now > before ? "yes" : now > 0 ? "partial" : "no",
      detail: `${now ?? "–"} opportunities in the window, ${before ?? "–"} in the window before (${prevStart} to ${prevEnd}). Attribution to this bet is a judgment, not a number.`,
    };
  } catch (err) {
    errors.push(`funnel: ${err instanceof Error ? err.message : String(err)}`);
  }

  const m = bet.measure;
  if (m) {
    try {
      if (m.kind === "funnel_stage") {
        const [f, p] = await Promise.all([funnelFor(client, cache, spec), funnelFor(client, cache, prevSpec)]);
        current = f.nodes[m.id]?.value ?? null;
        previous = p.nodes[m.id]?.value ?? null;
        const label = FUNNEL_METRICS.find((x) => x.id === m.id)?.label ?? f.nodes[m.id]?.title ?? m.id;
        source = `Funnel stage "${label}" over ${start} to ${effectiveEnd}`;
        if (!f.nodes[m.id]) errors.push(`unknown funnel stage: ${m.id}`);
      } else if (m.kind === "funnel_rate") {
        const [f, p] = await Promise.all([funnelFor(client, cache, spec), funnelFor(client, cache, prevSpec)]);
        const r = f.rates.find((x) => x.id === m.id);
        current = r?.value ?? null;
        previous = p.rates.find((x) => x.id === m.id)?.value ?? null;
        source = `Funnel rate "${r?.label ?? m.id}" over ${start} to ${effectiveEnd}`;
        if (!r) errors.push(`unknown funnel rate: ${m.id}`);
      } else if (m.kind === "ai_share") {
        const s = await getVisibilitySummary(client);
        if (m.id === "all") {
          current = s.overallShare;
          const runs = [...new Set(s.history.map((h) => h.runOn))].sort();
          const prevRun = runs.filter((d) => d < (s.runOn ?? "")).pop();
          if (prevRun) {
            const rows = s.history.filter((h) => h.runOn === prevRun);
            const samples = rows.reduce((a, h) => a + h.samples, 0);
            previous = samples ? rows.reduce((a, h) => a + h.mentioned, 0) / samples : null;
          }
          source = `AI visibility, all assistants, run ${s.runOn ?? "none"}`;
        } else {
          const e = s.engines.find((x) => x.engine === m.id);
          current = e?.share ?? null;
          const prevRun = [...new Set(s.history.filter((h) => h.engine === m.id).map((h) => h.runOn))].sort().filter((d) => d < (s.runOn ?? "")).pop();
          const ph = prevRun ? s.history.find((h) => h.engine === m.id && h.runOn === prevRun) : null;
          previous = ph && ph.samples ? ph.mentioned / ph.samples : null;
          source = `AI visibility, ${ENGINE_LABEL[m.id as AiEngine] ?? m.id}, run ${s.runOn ?? "none"}`;
          if (!(AI_ENGINES as readonly string[]).includes(m.id)) errors.push(`unknown assistant: ${m.id}`);
        }
      } else if (m.kind === "outbound_tag") {
        const endEx = iso(new Date(new Date(`${effectiveEnd}T00:00:00Z`).getTime() + DAY));
        const prevEndEx = iso(new Date(new Date(`${prevEnd}T00:00:00Z`).getTime() + DAY));
        const [now, before] = await Promise.all([outboundTagNumbers(client, m.id, start, endEx), outboundTagNumbers(client, m.id, prevStart, prevEndEx)]);
        const pick = (n: typeof now) =>
          m.submetric === "contacts" ? n.contacts : m.submetric === "meetings" ? n.meetings : m.submetric === "reply_rate" ? (n.contacts ? n.replies / n.contacts : null) : n.replies;
        current = pick(now);
        previous = pick(before);
        source = `Sequences tagged "${m.id}" (${now.sequences.join(", ") || "none"}): ${now.contacts} enrolled, ${now.replies} replied, ${now.meetings} meetings, ${start} to ${effectiveEnd}`;
        if (now.sequences.length === 0) errors.push(`no sequence carries the tag "${m.id}"`);
      } else if (m.kind === "manual") {
        current = bet.currentValue;
        source = `Typed by hand (${m.id})`;
      }
    } catch (err) {
      errors.push(`measure: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const threshold = m ? normalizeThreshold(m) : null;
  const comparator = m?.comparator ?? null;
  const met = m && threshold != null ? compare(current, m.comparator, threshold) : null;
  const isRate = m ? isRateMeasure(m) : false;
  const progress = m && current != null && threshold != null && m.comparator === ">=" && threshold > 0 ? Math.min(1, current / threshold) : null;

  const metricLevel: EvaluationLevel = !m
    ? { label: "Metric moved", status: "unknown", detail: "No measure on this bet; add one so this can be read automatically." }
    : current == null
      ? { label: "Metric moved", status: "unknown", detail: `${source || "The measure"} returned no number.` }
      : {
          label: "Metric moved",
          status: met ? "yes" : previous != null && ((m.comparator === ">=" && current > previous) || (m.comparator === "<=" && current < previous)) ? "partial" : "no",
          detail: `${fmtValue(current, isRate)} now${previous != null ? ` vs ${fmtValue(previous, isRate)} in the window before` : ""}; threshold ${m.comparator} ${fmtValue(threshold, isRate)}.`,
        };

  const action = await actionLevel(client, bet);

  const display = m
    ? `${fmtValue(current, isRate)} (${start} to ${effectiveEnd}) · threshold ${m.comparator} ${fmtValue(threshold, isRate)}${previous != null ? ` · before: ${fmtValue(previous, isRate)}` : ""}`
    : "No measure";

  let suggestedVerdict: string;
  if (!m || current == null) suggestedVerdict = "Not measurable yet: add or fix the measure before deciding.";
  else if (met && action.status === "yes") suggestedVerdict = `Held: ${metricLevel.detail} ${opportunities.status === "yes" ? "Opportunities rose too." : "Opportunities did not rise yet; keep watching the next stage."}`;
  else if (met) suggestedVerdict = `Threshold met, but the action is not marked executed; confirm the movement came from this bet before calling it.`;
  else if (daysLeft > 0) suggestedVerdict = `Not yet: ${metricLevel.detail} ${daysLeft} day${daysLeft === 1 ? "" : "s"} to the decision date.`;
  else if (action.status !== "yes") suggestedVerdict = `Decision date passed and the action was not executed: this bet was not tested. Reschedule or drop it.`;
  else suggestedVerdict = `Did not hold: ${metricLevel.detail} The action was executed; the number did not follow.`;

  return {
    betId: bet.id,
    measure: m,
    window: { start, end, effectiveEnd, elapsedShare: elapsedDays / totalDays },
    previousWindow: { start: prevStart, end: prevEnd },
    current,
    previous,
    threshold,
    comparator,
    met,
    progress,
    daysLeft,
    source,
    display,
    levels: { action, metric: metricLevel, opportunities },
    suggestedVerdict,
    errors,
  };
}

/** Evaluate many bets sharing one funnel cache. Failures land in `errors`, never throw. */
export async function evaluateBets(client: SupabaseClient, bets: Bet[]): Promise<Record<string, BetEvaluation>> {
  const cache: FunnelCache = new Map();
  const out: Record<string, BetEvaluation> = {};
  await Promise.all(
    bets.map(async (b) => {
      try {
        out[b.id] = await evaluateBet(client, b, cache);
      } catch (err) {
        out[b.id] = {
          betId: b.id,
          measure: b.measure,
          window: { start: b.createdAt.slice(0, 10), end: b.decisionAt, effectiveEnd: b.decisionAt, elapsedShare: 0 },
          previousWindow: null,
          current: null,
          previous: null,
          threshold: null,
          comparator: null,
          met: null,
          progress: null,
          daysLeft: 0,
          source: "",
          display: "Evaluation failed",
          levels: {
            action: { label: "Action executed", status: "unknown", detail: "" },
            metric: { label: "Metric moved", status: "unknown", detail: "" },
            opportunities: { label: "Reached opportunities", status: "unknown", detail: "" },
          },
          suggestedVerdict: "Evaluation failed.",
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }
    }),
  );
  return out;
}
