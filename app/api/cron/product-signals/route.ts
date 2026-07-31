import { NextResponse } from "next/server";

import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { runProductSignalsSweep } from "@/lib/product-signals/sweep";

export const maxDuration = 300;

// Product-signals sweep: BigQuery facts → tier classification → CRM sync.
// Same job the in-process scheduler runs every 4h; this route exists for
// manual triggers and external schedulers.
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runProductSignalsSweep(getSupabaseServiceClient());
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[cron/product-signals] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
