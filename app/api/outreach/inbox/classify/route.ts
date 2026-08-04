import { NextResponse } from "next/server";

import { classifyPendingReplyThreads } from "@/lib/outreach/reply-classification";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Ceiling on one manual run. Each unclassified thread can cost an LLM call. */
const MAX_LIMIT = 100;

/**
 * Manual trigger for reply classification, used to backfill threads that
 * predate the classifier. The cron covers the routine path.
 *
 * `force` (re-label already-classified threads) is deliberately NOT exposed
 * here. It is a maintenance action for after a prompt change, it re-spends the
 * LLM budget on work already done, and churning labels moves the dashboard's
 * reply mix under everyone else. The lib function still takes it, so a script
 * or a future admin surface can call it.
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
  const requested = typeof body.limit === "number" ? body.limit : 50;
  const limit = Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT);

  try {
    // Service role: classification writes to every thread regardless of who
    // owns the mailbox, same posture as the cron.
    const result = await classifyPendingReplyThreads(
      getSupabaseServiceClient(),
      { limit },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
