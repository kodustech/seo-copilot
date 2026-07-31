import { NextResponse } from "next/server";

import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { handleUnipileMessageReceived } from "@/lib/unipile-replies";
import type { UnipileWebhookPayload } from "@/lib/unipile";

/**
 * Unipile messaging webhook (message_received).
 * Optional: set UNIPILE_WEBHOOK_SECRET and send header X-Unipile-Secret when creating the webhook.
 */
export async function POST(req: Request) {
  const secret = process.env.UNIPILE_WEBHOOK_SECRET?.trim();
  if (secret) {
    const got = req.headers.get("x-unipile-secret");
    if (got !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let payload: UnipileWebhookPayload;
  try {
    payload = (await req.json()) as UnipileWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const client = getSupabaseServiceClient();
    const result = await handleUnipileMessageReceived(client, payload);
    console.log("[unipile] webhook", {
      event: payload.event,
      account_id: payload.account_id,
      ...result,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[unipile] webhook failed:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Webhook handler failed",
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "Unipile messaging webhook endpoint",
  });
}
