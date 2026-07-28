import { NextResponse } from "next/server";

import {
  getActivityStats,
  listReadyQueue,
  processDueSequenceTasks,
  promoteDueHumanQueue,
} from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * GET — daily activity queue (LinkedIn + email ready tasks).
 *
 * Fast path: promote due *human* work to ready, then list.
 * Does NOT run full processDue (auto email send) — that is cron-only so
 * the Sequences page does not hang for minutes.
 *
 * ?channel=linkedin|email optional filter
 */
export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    // Cheap promote only (no Gmail send). Full engine stays on cron.
    await promoteDueHumanQueue(client);

    const url = new URL(req.url);
    const channelParam = url.searchParams.get("channel");
    const channel =
      channelParam === "email" || channelParam === "linkedin"
        ? channelParam
        : undefined;

    const [tasks, stats] = await Promise.all([
      listReadyQueue(client, {
        channel,
        limit: 100,
      }),
      getActivityStats(client),
    ]);

    return NextResponse.json({ tasks, stats });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

/**
 * POST — run the full sequence engine once (send auto email + promote).
 * Optional for ops; cron is the normal path.
 */
export async function POST(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const result = await processDueSequenceTasks(client, {
      reseedOrphans: false,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
