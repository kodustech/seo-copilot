import { NextResponse } from "next/server";

import { BET_STATUSES, deleteBet, updateBet, type BetStatus } from "@/lib/bets";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const updates: Parameters<typeof updateBet>[2] = {};
  for (const k of ["title", "hypothesis", "action", "metric", "decisionAt"] as const) {
    if (typeof body[k] === "string") updates[k] = body[k] as string;
  }
  if (typeof body.status === "string" && (BET_STATUSES as string[]).includes(body.status)) updates.status = body.status as BetStatus;
  if ("verdict" in body) updates.verdict = typeof body.verdict === "string" ? body.verdict : null;
  if ("notes" in body) updates.notes = typeof body.notes === "string" ? body.notes : null;
  try {
    const bet = await updateBet(client, id, updates);
    return NextResponse.json({ bet });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await deleteBet(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
