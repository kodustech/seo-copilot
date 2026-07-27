import { NextResponse } from "next/server";

import {
  getSendingWindow,
  updateSendingWindow,
} from "@/lib/outreach/sending-window";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

export async function GET(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
    const client = getSupabaseServiceClient();
    const window = await getSendingWindow(client);
    return NextResponse.json({ window });
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

    const rawDays = body.sendingDays ?? body.sending_days;
    const window = await updateSendingWindow(client, {
      sendingDays: Array.isArray(rawDays)
        ? rawDays.map((d: unknown) => Number(d))
        : undefined,
      timezone:
        typeof body.timezone === "string" ? body.timezone : undefined,
      updatedByEmail: userEmail,
    });
    return NextResponse.json({ window });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
