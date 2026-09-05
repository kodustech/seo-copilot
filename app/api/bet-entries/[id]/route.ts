import { NextResponse } from "next/server";

import { deleteBetEntry } from "@/lib/bets";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await deleteBetEntry(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
