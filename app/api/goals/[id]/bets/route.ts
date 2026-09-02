import { NextResponse } from "next/server";

import { BET_STATUSES, createBet, listBets, type BetStatus } from "@/lib/bets";
import { getSupabaseUserClient } from "@/lib/supabase-server";

async function auth(req: Request) {
  return getSupabaseUserClient(req.headers.get("authorization"));
}

/** Bets of one goal. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const bets = await listBets(client, { goalId: id });
    return NextResponse.json({ bets });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

/** Create a bet on this goal. Refuses a fourth active bet. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client: Awaited<ReturnType<typeof auth>>["client"];
  let userEmail: string;
  try {
    ({ client, userEmail } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = typeof body.status === "string" && (BET_STATUSES as string[]).includes(body.status) ? (body.status as BetStatus) : undefined;
  try {
    const bet = await createBet(client, {
      goalId: id,
      title: String(body.title ?? ""),
      hypothesis: String(body.hypothesis ?? ""),
      action: String(body.action ?? ""),
      metric: String(body.metric ?? ""),
      decisionAt: String(body.decisionAt ?? ""),
      status,
      notes: typeof body.notes === "string" ? body.notes : null,
      createdByEmail: userEmail,
    });
    return NextResponse.json({ bet }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
