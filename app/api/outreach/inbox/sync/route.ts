import { NextResponse } from "next/server";

import {
  syncAllMailboxesInbox,
  syncMailboxInbox,
} from "@/lib/outreach/inbox";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST — manual Gmail reply sync.
 * Body optional: { mailboxId?: string }
 */
export async function POST(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    let mailboxId: string | undefined;
    try {
      const body = (await req.json()) as { mailboxId?: string };
      mailboxId = body.mailboxId?.trim() || undefined;
    } catch {
      /* empty body ok */
    }

    if (mailboxId) {
      const result = await syncMailboxInbox(client, mailboxId);
      return NextResponse.json({ results: [result] });
    }

    const results = await syncAllMailboxesInbox(client);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
