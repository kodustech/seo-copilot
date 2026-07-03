import { NextResponse } from "next/server";

import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { generateNotificationsForAllUsers } from "@/lib/notifications";

export const maxDuration = 120;

// Generates per-user notifications from the attention feed, for all users.
// Idempotent (deduped by user_email + dedupe_key).
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = getSupabaseServiceClient();
    const result = await generateNotificationsForAllUsers(client);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[cron/notifications] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
