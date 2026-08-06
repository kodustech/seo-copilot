import { NextResponse } from "next/server";

import {
  processDueSequenceTasks,
  refreshCrmSignalVars,
} from "@/lib/outreach/sequences";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = getSupabaseServiceClient();
    // Refresh first: an email held back for an unfilled {{token}} should go out
    // on the same tick the account data that fills it lands, not the next one.
    // A failure here must not stop the sends — it only costs freshness.
    let signalRefresh: { enrollmentsUpdated: number; tasksRerendered: number } =
      { enrollmentsUpdated: 0, tasksRerendered: 0 };
    try {
      signalRefresh = await refreshCrmSignalVars(client);
    } catch (err) {
      console.error("[outreach-sequences] signal var refresh failed", err);
    }
    const result = await processDueSequenceTasks(client, {
      reseedOrphans: true,
    });
    return NextResponse.json({ ok: true, ...result, signalRefresh });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
