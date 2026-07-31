import { NextResponse } from "next/server";

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
  } catch (err) {
    console.warn("[unipile] account-notify parse failed:", err);
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST notify from Unipile" });
}
