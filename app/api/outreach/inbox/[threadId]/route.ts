import { NextResponse } from "next/server";

import {
  getReplyThread,
  gmailThreadUrl,
  updateReplyThread,
  type ReplyThreadStatus,
} from "@/lib/outreach/inbox";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ threadId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { threadId } = await ctx.params;
    const detail = await getReplyThread(client, threadId);
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      ...detail,
      gmailUrl:
        detail.thread.channel === "email"
          ? gmailThreadUrl(detail.thread.gmailThreadId)
          : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

/**
 * PATCH — update triage status / snooze.
 * Body: { status?: new|open|done|snoozed, snoozedUntil?: string|null }
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { threadId } = await ctx.params;
    const body = (await req.json()) as {
      status?: string;
      snoozedUntil?: string | null;
    };

    const allowed: ReplyThreadStatus[] = ["new", "open", "done", "snoozed"];
    const status =
      body.status && allowed.includes(body.status as ReplyThreadStatus)
        ? (body.status as ReplyThreadStatus)
        : undefined;

    const thread = await updateReplyThread(client, threadId, {
      status,
      snoozedUntil: body.snoozedUntil,
    });
    return NextResponse.json({ thread });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
