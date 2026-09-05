import { NextResponse } from "next/server";

import { addBetEntry, listBetEntries, type BetEntryKind, BET_ENTRY_KINDS } from "@/lib/bets";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/** The journal of one bet, oldest first. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const entries = await listBetEntries(client, [id]);
    return NextResponse.json({ entries: entries[id] ?? [] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

/** Add an entry. Body: { text, kind?, url?, happenedOn? }. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  let userEmail: string;
  try {
    ({ client, userEmail } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const entry = await addBetEntry(client, {
      betId: id,
      text: String(body.text ?? ""),
      kind: typeof body.kind === "string" && (BET_ENTRY_KINDS as string[]).includes(body.kind) ? (body.kind as BetEntryKind) : undefined,
      url: typeof body.url === "string" ? body.url : null,
      happenedOn: typeof body.happenedOn === "string" && body.happenedOn ? body.happenedOn : null,
      authorEmail: userEmail,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
