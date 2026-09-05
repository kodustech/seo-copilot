import { NextResponse } from "next/server";

import { evaluateBet } from "@/lib/bet-evaluation";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/** Read one bet against its measure: current number, threshold, the three follow-up levels, a suggested verdict. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ evaluation: await evaluateBet(client, id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
