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
  if ("lever" in body) updates.lever = typeof body.lever === "string" ? body.lever : null;
  if ("ownerEmail" in body) updates.ownerEmail = typeof body.ownerEmail === "string" ? body.ownerEmail : null;
  if ("kanbanItemId" in body) updates.kanbanItemId = typeof body.kanbanItemId === "string" && body.kanbanItemId ? body.kanbanItemId : null;
  if ("measure" in body) updates.measure = (body.measure ?? null) as Parameters<typeof updateBet>[2]["measure"];
  if ("currentValue" in body) updates.currentValue = body.currentValue == null || body.currentValue === "" ? null : Number(body.currentValue);
  if ("actionDoneAt" in body) updates.actionDoneAt = typeof body.actionDoneAt === "string" && body.actionDoneAt ? body.actionDoneAt : null;
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
