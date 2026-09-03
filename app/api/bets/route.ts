import { NextResponse } from "next/server";

import { listBets, MAX_ACTIVE_BETS } from "@/lib/bets";
import { listGoals } from "@/lib/goals";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * Every bet, with the goal it serves. The Goals page opens with this list so
 * the three active bets are the first thing on screen, not something buried
 * inside each goal card.
 */
export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  try {
    const [bets, goals] = await Promise.all([
      listBets(client, { limit: 500 }),
      listGoals(client, { periodScope: "all", limit: 500 }),
    ]);
    const goalById = new Map(goals.map((g) => [g.id, g]));
    return NextResponse.json({
      maxActive: MAX_ACTIVE_BETS,
      bets: bets.map((b) => {
        const g = goalById.get(b.goalId);
        return {
          ...b,
          goalTitle: g?.title ?? null,
          goalPeriod: g ? `${g.periodStart}..${g.periodEnd}` : null,
          goalFunnelMetric: g?.funnelMetric ?? null,
        };
      }),
      goals: goals
        .filter((g) => g.status === "active")
        .map((g) => ({ id: g.id, title: g.title, periodStart: g.periodStart, periodEnd: g.periodEnd })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
