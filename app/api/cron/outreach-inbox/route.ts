import { NextResponse } from "next/server";

import { syncAllMailboxesInbox } from "@/lib/outreach/inbox";
import {
  classifyPendingReplyThreads,
  reconcileClassifiedReplyThreads,
} from "@/lib/outreach/reply-classification";
import { syncUnipileLinkedInInbox } from "@/lib/unipile-replies";
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
    const client = getSupabaseServiceClient();
    const results = await syncAllMailboxesInbox(client);
    const linkedin = await syncUnipileLinkedInInbox(client);

    // Classification runs after sync and never fails the run: an LLM outage
    // must not look like an inbox sync failure, and unlabeled threads are
    // picked up again on the next pass.
    let classification: unknown = null;
    try {
      classification = await classifyPendingReplyThreads(client, { limit: 40 });
    } catch (err) {
      classification = {
        error: err instanceof Error ? err.message : "classification failed",
      };
      console.error("[cron/outreach-inbox] classification failed", err);
    }

    // Catch up on labels written before the class drove anything — chiefly the
    // out-of-office threads that stopped a cadence. Drains to a no-op.
    let reconciliation: unknown = null;
    try {
      reconciliation = await reconcileClassifiedReplyThreads(client, {
        limit: 50,
      });
    } catch (err) {
      reconciliation = {
        error: err instanceof Error ? err.message : "reconciliation failed",
      };
      console.error("[cron/outreach-inbox] reconciliation failed", err);
    }

    return NextResponse.json({
      ok: true,
      mailboxes: results.length,
      results,
      linkedin,
      classification,
      reconciliation,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return POST(req);
}
