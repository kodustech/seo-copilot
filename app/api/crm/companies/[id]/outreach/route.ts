import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  CRM_OUTREACH_CHANNELS,
  recordManualOutreach,
  type CrmOutreachChannel,
} from "@/lib/crm";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  let userEmail;
  try {
    ({ client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    ));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const channel = typeof body.channel === "string" ? body.channel : "";
  if (!CRM_OUTREACH_CHANNELS.includes(channel as CrmOutreachChannel)) {
    return NextResponse.json(
      { error: `channel must be one of: ${CRM_OUTREACH_CHANNELS.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const company = await recordManualOutreach(
      client,
      id,
      {
        channel: channel as CrmOutreachChannel,
        contactId: typeof body.contactId === "string" ? body.contactId : null,
        contactName:
          typeof body.contactName === "string" ? body.contactName : null,
        note: typeof body.note === "string" ? body.note : null,
        sentAt: typeof body.sentAt === "string" ? body.sentAt : null,
      },
      userEmail,
    );
    return NextResponse.json({ company }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to record outreach";
    const status = /invalid|valid date|future|does not belong/i.test(message)
      ? 400
      : /not found/i.test(message)
        ? 404
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
