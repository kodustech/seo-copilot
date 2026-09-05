import type { SupabaseClient } from "@supabase/supabase-js";

import { getVisibilitySummary, ENGINE_LABEL, type AiEngine, AI_ENGINES } from "@/lib/ai-visibility";
import { getBet, listBetEntries, type Bet, type BetEntry, type BetMeasure } from "@/lib/bets";
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
  /** What was actually done, entry by entry, oldest first. */
  journal: BetEntry[];
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

// Shared reads for one evaluation batch (a page load evaluates every open
// bet): funnel results per spec, and the AI visibility summary once.
type FunnelCache = Map<string, Promise<FunnelData>> & { visibility?: Promise<Awaited<ReturnType<typeof getVisibilitySummary>>> };

function visibilityFor(client: SupabaseClient, cache: FunnelCache) {
  if (!cache.visibility) cache.visibility = getVisibilitySummary(client);
  return cache.visibility;
}

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
  needMeetings: boolean,
): Promise<{ contacts: number; replies: number; meetings: number; sequences: string[] }> {
  const { data: seqs, error } = await client.from("outreach_sequences").select("id,name,tags").contains("tags", [tag]);
  if (error) throw new Error(`outreach_sequences: ${error.message}`);
  const ids = (seqs ?? []).map((s) => String(s.id));
  const sequences = (seqs ?? []).map((s) => String(s.name));
  if (ids.length === 0) return { contacts: 0, replies: 0, meetings: 0, sequences };

  // Counts come from the database, not from rows: exact at any size and one
  // round trip each.
  const windowed = () =>
    client
      .from("outreach_enrollments")
      .select("id", { count: "exact", head: true })
      .in("sequence_id", ids)
      .gte("created_at", `${start}T00:00:00Z`)
      .lt("created_at", `${endExclusive}T00:00:00Z`);
  const [{ count: contacts, error: cErr }, { count: replies, error: rErr }] = await Promise.all([windowed(), windowed().eq("status", "replied")]);
  if (cErr) throw new Error(`outreach_enrollments: ${cErr.message}`);
  if (rErr) throw new Error(`outreach_enrollments: ${rErr.message}`);

  let meetings = 0;
  if (needMeetings) {
    // A meeting counts when the enrolled company moved to `meeting` inside
    // the window and after its enrollment started (the calendar sync writes
    // that status). Companies are read in parallel pages; the status
    // changes are bounded to the window on both ends.
    const PAGE = 1000;
    const { count: withCompany, error: wcErr } = await windowed().not("crm_company_id", "is", null);
    if (wcErr) throw new Error(`outreach_enrollments: ${wcErr.message}`);
    const page = (i: number) =>
      client
        .from("outreach_enrollments")
        .select("crm_company_id,created_at")
        .in("sequence_id", ids)
        .not("crm_company_id", "is", null)
        .gte("created_at", `${start}T00:00:00Z`)
        .lt("created_at", `${endExclusive}T00:00:00Z`)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(i * PAGE, i * PAGE + PAGE - 1);
    // Pages read in parallel from the count, then one more at a time until a
    // short page, so rows inserted between the count and the reads still land.
    const pages = Math.ceil((withCompany ?? 0) / PAGE);
    const results = await Promise.all(Array.from({ length: pages }, (_, i) => page(i)));
    // Rows landing between the count and the reads are a page or two, never
    // unbounded: a few extra pages, then stop.
    const MAX_TAIL = 5;
    for (let i = pages; i < pages + MAX_TAIL; i++) {
      const extra = await page(i);
      if (extra.error) throw new Error(`outreach_enrollments: ${extra.error.message}`);
      results.push(extra);
      if ((extra.data ?? []).length < PAGE) break;
    }
    const startedAt = new Map<string, string>();
    for (const r of results) {
      if (r.error) throw new Error(`outreach_enrollments: ${r.error.message}`);
      for (const row of r.data ?? []) startedAt.set(String(row.crm_company_id), String(row.created_at));
    }
    const companyIds = [...startedAt.keys()];
    const seen = new Set<string>();
    for (let i = 0; i < companyIds.length; i += 200) {
      const { data: acts } = await client
        .from("crm_activities")
        .select("company_id,created_at,meta")
        .eq("kind", "status_change")
        .in("company_id", companyIds.slice(i, i + 200))
        .gte("created_at", `${start}T00:00:00Z`)
        .lt("created_at", `${endExclusive}T00:00:00Z`)
        .order("created_at", { ascending: true })
        .limit(5000);
      for (const a of acts ?? []) {
        const meta = (a.meta ?? {}) as { to?: string };
        const cid = String(a.company_id);
        if (meta.to === "meeting" && String(a.created_at) >= (startedAt.get(cid) ?? "") && !seen.has(cid)) seen.add(cid);
      }
    }
    meetings = seen.size;
  }
  return { contacts: contacts ?? 0, replies: replies ?? 0, meetings, sequences };
}

async function actionLevel(client: SupabaseClient, bet: Bet, journal: BetEntry[]): Promise<EvaluationLevel> {
  if (bet.actionDoneAt) return { label: "Action executed", status: "yes", detail: `Marked done ${bet.actionDoneAt.slice(0, 10)}.${journal.length ? ` ${journal.length} journal entr${journal.length === 1 ? "y" : "ies"}.` : ""}` };
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
  if (journal.length) {
    const last = journal[journal.length - 1];
    const artifacts = journal.filter((e) => e.kind === "artifact").length;
    return {
      label: "Action executed",
      status: "partial",
      detail: `${journal.length} journal entr${journal.length === 1 ? "y" : "ies"}${artifacts ? `, ${artifacts} with a link` : ""}; last on ${last.happenedOn}: "${last.text.slice(0, 80)}". Not marked done yet.`,
    };
  }
  if (bet.status === "queued") return { label: "Action executed", status: "no", detail: "Bet has not started." };
  return { label: "Action executed", status: "unknown", detail: "Nothing in the journal, no Kanban card, no done date. Log what was done, or mark it executed." };
}

export async function evaluateBet(
  client: SupabaseClient,
  betOrId: Bet | string,
  cache: FunnelCache = new Map(),
  journalIn?: BetEntry[] | Promise<BetEntry[]>,
): Promise<BetEvaluation> {
  const bet = typeof betOrId === "string" ? await getBet(client, betOrId) : betOrId;
  if (!bet) throw new Error("Bet not found");
  // The journal is only needed for the action level, after the metric reads,
  // so its fetch overlaps them instead of preceding them.
  const journalP: Promise<BetEntry[]> = journalIn
    ? Promise.resolve(journalIn)
    : listBetEntries(client, [bet.id]).then((j) => j[bet.id] ?? []);
  // Marked handled: a journal failure is recorded at the await below, not
  // raised as an unhandled rejection while the metric reads are in flight.
  void journalP.catch(() => {});
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
        const s = await visibilityFor(client, cache);
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
        const needMeetings = m.submetric === "meetings";
        const [now, before] = await Promise.all([
          outboundTagNumbers(client, m.id, start, endEx, needMeetings),
          outboundTagNumbers(client, m.id, prevStart, prevEndEx, needMeetings),
        ]);
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

  // A journal failure degrades like any other read: recorded, not fatal,
  // and never read as "nothing was logged".
  let journalReadFailed = false;
  const journal = await journalP.catch((err) => {
    errors.push(`journal: ${err instanceof Error ? err.message : String(err)}`);
    journalReadFailed = true;
    return [] as BetEntry[];
  });
  let action = await actionLevel(client, bet, journal);
  if (journalReadFailed && action.status === "unknown") action = { ...action, detail: "Journal could not be read; execution is unknown." };

  const display = m
    ? `${fmtValue(current, isRate)} (${start} to ${effectiveEnd}) · threshold ${m.comparator} ${fmtValue(threshold, isRate)}${previous != null ? ` · before: ${fmtValue(previous, isRate)}` : ""}`
    : "No measure";

  let suggestedVerdict: string;
  if (!m || current == null) suggestedVerdict = "Not measurable yet: add or fix the measure before deciding.";
  else if (met && action.status === "yes") suggestedVerdict = `Held: ${metricLevel.detail} ${opportunities.status === "yes" ? "Opportunities rose too." : "Opportunities did not rise yet; keep watching the next stage."}`;
  else if (met) suggestedVerdict = `Threshold met, but the action is not marked executed; confirm the movement came from this bet before calling it.`;
  else if (daysLeft > 0) suggestedVerdict = `Not yet: ${metricLevel.detail} ${daysLeft} day${daysLeft === 1 ? "" : "s"} to the decision date.`;
  else if (action.status !== "yes" && journalReadFailed) suggestedVerdict = `Decision date passed but the journal could not be read; confirm the action was executed before deciding.`;
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
    journal,
    suggestedVerdict,
    errors,
  };
}

/** Evaluate many bets sharing one funnel cache. Failures land in `errors`, never throw. */
export async function evaluateBets(
  client: SupabaseClient,
  bets: Bet[],
  journalsIn?: Record<string, BetEntry[]> | Promise<Record<string, BetEntry[]>>,
): Promise<Record<string, BetEvaluation>> {
  const cache: FunnelCache = new Map();
  const out: Record<string, BetEvaluation> = {};
  // A caller that is already reading the journals (the page) passes that
  // read in, so the entries are fetched once per request. Each bet awaits
  // its own slice only when it needs it, so the metric reads run meanwhile.
  const journalsP = Promise.resolve(journalsIn ?? listBetEntries(client, bets.map((b) => b.id)));
  await Promise.all(
    bets.map(async (b) => {
      try {
        out[b.id] = await evaluateBet(client, b, cache, journalsP.then((j) => j[b.id] ?? []));
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
          journal: (await journalsP.catch(() => ({}) as Record<string, BetEntry[]>))[b.id] ?? [],
          suggestedVerdict: "Evaluation failed.",
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }
    }),
  );
  return out;
}
