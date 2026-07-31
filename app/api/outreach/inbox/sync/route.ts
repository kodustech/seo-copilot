import { NextResponse } from "next/server";

import {
  syncAllMailboxesInbox,
  syncMailboxInbox,
} from "@/lib/outreach/inbox";
import { syncUnipileLinkedInInbox } from "@/lib/unipile-replies";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST — manual Gmail + LinkedIn (Unipile) reply sync.
 * Body optional: { mailboxId?: string, skipGmail?: boolean, skipLinkedin?: boolean }
 */
export async function POST(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    let mailboxId: string | undefined;
    let skipGmail = false;
    let skipLinkedin = false;
    try {
      const body = (await req.json()) as {
        mailboxId?: string;
        skipGmail?: boolean;
        skipLinkedin?: boolean;
      };
      mailboxId = body.mailboxId?.trim() || undefined;
      skipGmail = Boolean(body.skipGmail);
      skipLinkedin = Boolean(body.skipLinkedin);
    } catch {
      /* empty body ok */
    }

    let results: Awaited<ReturnType<typeof syncAllMailboxesInbox>> = [];
    if (!skipGmail) {
      if (mailboxId) {
        results = [await syncMailboxInbox(client, mailboxId)];
      } else {
        results = await syncAllMailboxesInbox(client);
      }
    }

    const linkedin = skipLinkedin
      ? null
      : await syncUnipileLinkedInInbox(client);

    return NextResponse.json({ results, linkedin });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
