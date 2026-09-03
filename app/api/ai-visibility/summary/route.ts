import { NextResponse } from "next/server";

import { getVisibilitySummary, listRunDates } from "@/lib/ai-visibility";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/** Latest run (or ?runOn=YYYY-MM-DD) with per-engine, per-prompt and per-domain views. */
export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const raw = url.searchParams.get("runOn")?.trim();
  const runOn = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  try {
    const [summary, dates] = await Promise.all([getVisibilitySummary(client, { runOn }), listRunDates(client)]);
    return NextResponse.json({ summary, dates });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
