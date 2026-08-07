import { NextResponse } from "next/server";

import { requestUnipileAccountsRefresh } from "@/lib/unipile";

/**
 * Unipile Hosted Auth notify_url callback.
 * Payload: { status, account_id, name }
 * We don't need to store mapping yet — accounts are listed live from Unipile.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    console.log("[unipile] account-notify", {
      status: (body as { status?: string }).status,
      account_id: (body as { account_id?: string }).account_id,
      name: (body as { name?: string }).name,
    });
    // This endpoint is public and unauthenticated, so the payload only gets
    // to invalidate the shared cache when it looks like a real connect — and
    // the refresh is throttled, so spamming it cannot turn into unbounded
    // /accounts traffic against the rate-limited account.
    const status = String((body as { status?: string }).status ?? "");
    const accountId = (body as { account_id?: string }).account_id;
    if (accountId && /success|created|connected|reconnect/i.test(status)) {
      requestUnipileAccountsRefresh();
    }
  } catch (err) {
    console.warn("[unipile] account-notify parse failed:", err);
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST notify from Unipile" });
}
