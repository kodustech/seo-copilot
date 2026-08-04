import { NextResponse } from "next/server";

import { classifyPendingReplyThreads } from "@/lib/outreach/reply-classification";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Manual trigger for reply classification. The cron already does this after
 * each inbox sync; this exists to backfill threads that predate the classifier
 * and to re-label after a prompt change (`force`).
 */
export async function POST(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const limit = typeof body.limit === "number" ? body.limit : 50;
  const force = body.force === true;

  try {
    // Service role: classification writes to every thread regardless of who
    // owns the mailbox, same posture as the cron.
    const result = await classifyPendingReplyThreads(
      getSupabaseServiceClient(),
      { limit, force },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
