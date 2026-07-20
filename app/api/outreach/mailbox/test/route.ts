import { NextResponse } from "next/server";

import { testMailboxConnection } from "@/lib/outreach/send-email";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

/** POST { id } — verify SMTP credentials for a saved mailbox. */
export async function POST(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
    const body = await req.json().catch(() => ({}));
    const id = String(body.id ?? "");
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    const client = getSupabaseServiceClient();
    const result = await testMailboxConnection(client, id);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 401 },
    );
  }
}
