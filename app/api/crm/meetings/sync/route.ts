import { NextResponse } from "next/server";

import { syncCalendarMeetings } from "@/lib/crm-meetings";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Manual run of the calendar → CRM meeting sync, same code as the cron. */
export async function POST(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
  try {
    const result = await syncCalendarMeetings(client);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 },
    );
  }
}
