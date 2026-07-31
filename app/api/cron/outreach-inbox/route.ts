import { NextResponse } from "next/server";

import { syncAllMailboxesInbox } from "@/lib/outreach/inbox";
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
    return NextResponse.json({
      ok: true,
      mailboxes: results.length,
      results,
      linkedin,
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
