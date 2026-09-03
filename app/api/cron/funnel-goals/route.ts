import { NextResponse } from "next/server";

import { syncFunnelGoals } from "@/lib/funnel/goals";
import { fetchFunnel } from "@/lib/funnel/metrics";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await syncFunnelGoals(getSupabaseServiceClient(), fetchFunnel);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "funnel-goals failed" }, { status: 500 });
  }
}
