import { NextResponse } from "next/server";

import {
  getActivityStats,
  listReadyQueue,
  processDueSequenceTasks,
} from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * GET — daily activity queue (LinkedIn + email ready tasks).
 * ?channel=linkedin|email optional filter
 */
export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    await processDueSequenceTasks(client);
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
