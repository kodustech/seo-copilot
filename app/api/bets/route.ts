import { NextResponse } from "next/server";

import { AI_ENGINES, ENGINE_LABEL } from "@/lib/ai-visibility";
import { evaluateBets } from "@/lib/bet-evaluation";
import { BET_STATUSES, createBet, listBets, type BetStatus } from "@/lib/bets";
import { FUNNEL_METRICS } from "@/lib/funnel/goals";
import { listGoals } from "@/lib/goals";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/** Funnel rates a bet can measure, with the label the page shows. */
export const FUNNEL_RATE_OPTIONS: { id: string; label: string }[] = [
  { id: "ctr", label: "CTR (impressions → clicks)" },
  { id: "connected", label: "Signups that connect a git" },
  { id: "icp_share", label: "Signups that pass the ICP proxy" },
  { id: "survey", label: "Signups answering the survey" },
  { id: "touch_48h", label: "ICP signups touched within 48 h" },
  { id: "conv_to_opp", label: "Conversation → opportunity" },
  { id: "conv_to_meeting", label: "Conversation → meeting" },
  { id: "meeting_to_opp", label: "Meeting → opportunity" },
  { id: "opp_active", label: "Open opportunities with recent activity" },
  { id: "cold_reply", label: "Cold reply rate (human replies / contacts)" },
  { id: "cold_bounce", label: "Cold email bounce rate" },
  { id: "reply_to_conversation", label: "Cold reply → conversation" },
  { id: "reply_to_meeting", label: "Cold reply → meeting" },
  { id: "reply_to_opp", label: "Cold reply → opportunity" },
];

/**
 * Every bet with its evaluation, the goals it can hang on, and the options
 * the measure picker needs (stages, rates, assistants, sequence tags,
 * Kanban cards). One call feeds the whole Bets page.
 */
export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const withEvaluation = url.searchParams.get("evaluate") !== "0";
  try {
    const [bets, goals, { data: seqRows }, { data: itemRows }] = await Promise.all([
      listBets(client, { limit: 500 }),
      listGoals(client, { periodScope: "all", limit: 500 }),
      client.from("outreach_sequences").select("tags").limit(500),
      client.from("growth_work_items").select("id,title,stage").order("created_at", { ascending: false }).limit(200),
    ]);
    const goalById = new Map(goals.map((g) => [g.id, g]));
    const tags = [...new Set((seqRows ?? []).flatMap((r) => (Array.isArray(r.tags) ? (r.tags as string[]) : [])))].sort();
    const evaluations = withEvaluation ? await evaluateBets(client, bets) : {};
    return NextResponse.json({
      bets: bets.map((b) => {
        const g = goalById.get(b.goalId);
        return { ...b, goalTitle: g?.title ?? null, goalPeriod: g ? `${g.periodStart}..${g.periodEnd}` : null, goalFunnelMetric: g?.funnelMetric ?? null, evaluation: evaluations[b.id] ?? null };
      }),
      goals: goals.filter((g) => g.status === "active").map((g) => ({ id: g.id, title: g.title, periodStart: g.periodStart, periodEnd: g.periodEnd, funnelMetric: g.funnelMetric ?? null })),
      options: {
        funnelStages: FUNNEL_METRICS,
        funnelRates: FUNNEL_RATE_OPTIONS,
        assistants: [{ id: "all", label: "All assistants" }, ...AI_ENGINES.map((e) => ({ id: e, label: ENGINE_LABEL[e] }))],
        sequenceTags: tags,
        workItems: (itemRows ?? []).map((r) => ({ id: String(r.id), title: String(r.title), stage: (r.stage as string | null) ?? null })),
        levers: [...new Set(bets.map((b) => b.lever).filter((v): v is string => Boolean(v)))].sort(),
        owners: [...new Set(bets.map((b) => b.ownerEmail).filter((v): v is string => Boolean(v)))].sort(),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

/** Create a bet. Body: { goalId, title, hypothesis, action, metric, decisionAt, status?, lever?, ownerEmail?, measure?, kanbanItemId?, notes? }. */
export async function POST(req: Request) {
  let client;
  let userEmail: string;
  try {
    ({ client, userEmail } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = typeof body.status === "string" && (BET_STATUSES as string[]).includes(body.status) ? (body.status as BetStatus) : undefined;
  try {
    const bet = await createBet(client, {
      goalId: String(body.goalId ?? ""),
      title: String(body.title ?? ""),
      hypothesis: String(body.hypothesis ?? ""),
      action: String(body.action ?? ""),
      metric: String(body.metric ?? ""),
      decisionAt: String(body.decisionAt ?? ""),
      status,
      notes: typeof body.notes === "string" ? body.notes : null,
      lever: typeof body.lever === "string" ? body.lever : null,
      ownerEmail: typeof body.ownerEmail === "string" ? body.ownerEmail : null,
      kanbanItemId: typeof body.kanbanItemId === "string" && body.kanbanItemId ? body.kanbanItemId : null,
      measure: (body.measure ?? null) as Parameters<typeof createBet>[1]["measure"],
      currentValue: body.currentValue == null || body.currentValue === "" ? null : Number(body.currentValue),
      createdByEmail: userEmail,
    });
    return NextResponse.json({ bet }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
