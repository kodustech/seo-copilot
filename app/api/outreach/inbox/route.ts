import { NextResponse } from "next/server";

import {
  listReplyThreads,
  type ReplyThreadStatus,
} from "@/lib/outreach/inbox";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * GET — list reply threads for the outbound inbox.
 * Query: status=active|new|open|done|snoozed|all, mailbox_id, limit
 */
export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status") ?? "active";
    const status =
      statusParam === "active" ||
      statusParam === "all" ||
      statusParam === "new" ||
      statusParam === "open" ||
      statusParam === "done" ||
      statusParam === "snoozed"
        ? (statusParam as ReplyThreadStatus | "active" | "all")
        : "active";
    const mailboxId = url.searchParams.get("mailbox_id") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 50;

    const result = await listReplyThreads(client, {
      status,
      mailboxId,
      limit: Number.isFinite(limit) ? limit : 50,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
