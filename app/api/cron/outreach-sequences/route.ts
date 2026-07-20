import { NextResponse } from "next/server";

import { processDueSequenceTasks } from "@/lib/outreach/sequences";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = getSupabaseServiceClient();
    const result = await processDueSequenceTasks(client);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
