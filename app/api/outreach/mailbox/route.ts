import { NextResponse } from "next/server";

import {
  deleteMailbox,
  listMailboxes,
  upsertMailbox,
} from "@/lib/outreach/mailbox";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * Product config for sequence email send.
 * Secrets written via service client; password never returned.
 */
export async function GET(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
    // service client can read full row; we only map public fields
    const client = getSupabaseServiceClient();
    const mailboxes = await listMailboxes(client);
    return NextResponse.json({ mailboxes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = await req.json().catch(() => ({}));
    const client = getSupabaseServiceClient();
    const mailbox = await upsertMailbox(client, {
      id: typeof body.id === "string" ? body.id : undefined,
      label: body.label,
      fromName: body.fromName ?? body.from_name,
      fromEmail: String(body.fromEmail ?? body.from_email ?? ""),
      provider: body.provider === "gmail" ? "gmail" : "smtp",
      smtpHost: body.smtpHost ?? body.smtp_host,
      smtpPort:
        body.smtpPort != null
          ? Number(body.smtpPort)
          : body.smtp_port != null
            ? Number(body.smtp_port)
            : undefined,
      smtpSecure: body.smtpSecure ?? body.smtp_secure,
      smtpUser: String(body.smtpUser ?? body.smtp_user ?? ""),
      smtpPass: body.smtpPass ?? body.smtp_pass ?? body.password ?? null,
      dailyCap:
        body.dailyCap != null
          ? Number(body.dailyCap)
          : body.daily_cap != null
            ? Number(body.daily_cap)
            : undefined,
      isDefault: body.isDefault !== false && body.is_default !== false,
      enabled: body.enabled !== false,
      createdByEmail: userEmail,
    });
    return NextResponse.json({ mailbox }, { status: body.id ? 200 : 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    const client = getSupabaseServiceClient();
    await deleteMailbox(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
