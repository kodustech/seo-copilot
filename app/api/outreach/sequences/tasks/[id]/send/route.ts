import { NextResponse } from "next/server";

import { sendTaskNow } from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — send this queued email now, through the sequence's own mailbox.
 *
 * Separate from .../complete: that route records an outcome a human claims
 * happened elsewhere. This one actually sends, so the thread, the cap and the
 * CRM timeline all know about it.
 *
 * Optional body { subject, body }: copy edited in the queue before pressing
 * send. It replaces the rendered template for this task alone — the step
 * everyone else is rendered from is untouched.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    // The button sends nothing when the copy was not touched, so an absent or
    // unparseable body is the normal case, not an error.
    const payload = (await req.json().catch(() => ({}))) as {
      subject?: unknown;
      body?: unknown;
    };
    const result = await sendTaskNow(client, id, {
      sentByEmail: userEmail,
      subject: typeof payload.subject === "string" ? payload.subject : undefined,
      body: typeof payload.body === "string" ? payload.body : undefined,
    });
    if (!result.ok) {
      // 409, not 500: the send did not happen, but nothing is broken — the cap
      // is full, the mailbox is disconnected, or the address bounced.
      return NextResponse.json(
        { error: result.error, status: result.status },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
