import { NextResponse } from "next/server";

import { getSettings, isDataForSeoConfigured, isDueToday, runAiVisibility } from "@/lib/ai-visibility";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Weekly prompt run. The in-process scheduler calls this daily; it only asks
 * on the configured weekday and once per day. `?force=1` asks regardless.
 */
export async function POST(req: Request) {
  // Fail closed: without a CRON_SECRET nobody gets in. This route spends
  // DataForSEO credits, so an unset secret must not mean an open door.
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isDataForSeoConfigured()) {
    return NextResponse.json({ ok: false, error: "DataForSEO not configured" }, { status: 400 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    const client = getSupabaseServiceClient();
    const settings = await getSettings(client);
    if (!force && !isDueToday(settings)) {
      return NextResponse.json({ ok: true, ran: false, weekday: settings.weekday, lastRunOn: settings.lastRunOn });
    }
    const summary = await runAiVisibility(client, { force });
    return NextResponse.json({ ok: true, ran: true, summary });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
