import { NextResponse } from "next/server";

import {
  bulkUpdateReplyThreads,
  listReplyThreads,
  type ReplyChannel,
  type ReplyThreadStatus,
} from "@/lib/outreach/inbox";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * GET — list reply threads for the outbound inbox.
 * Query: status=active|new|open|done|snoozed|all, channel=all|email|linkedin, mailbox_id, limit
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
    const channelParam = url.searchParams.get("channel") ?? "all";
    const channel =
      channelParam === "email" ||
      channelParam === "linkedin" ||
      channelParam === "all"
        ? (channelParam as ReplyChannel | "all")
        : "all";
    const mailboxId = url.searchParams.get("mailbox_id") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 50;

    const result = await listReplyThreads(client, {
      status,
      channel,
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

/**
 * PATCH — bulk triage (e.g. mark many as done).
 * Body: { threadIds: string[], status?: new|open|done|snoozed, snoozedUntil?: string|null }
 */
export async function PATCH(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = (await req.json()) as {
      threadIds?: string[];
      status?: string;
      snoozedUntil?: string | null;
    };
    const threadIds = Array.isArray(body.threadIds) ? body.threadIds : [];
    if (threadIds.length === 0) {
      return NextResponse.json(
        { error: "threadIds required" },
        { status: 400 },
      );
    }

    const allowed: ReplyThreadStatus[] = ["new", "open", "done", "snoozed"];
    const status =
      body.status && allowed.includes(body.status as ReplyThreadStatus)
        ? (body.status as ReplyThreadStatus)
        : undefined;
    if (!status && body.snoozedUntil === undefined) {
      return NextResponse.json(
        { error: "status or snoozedUntil required" },
        { status: 400 },
      );
    }

    const result = await bulkUpdateReplyThreads(client, threadIds, {
      status,
      snoozedUntil: body.snoozedUntil,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
