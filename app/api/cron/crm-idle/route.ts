import { NextResponse } from "next/server";

import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { getStaleCompanies } from "@/lib/crm";

export const maxDuration = 60;

// Idle-account sweep. Returns companies whose time-since-last-activity has
// crossed the per-status SLA (crm_status_sla). Meant to be polled by a cron
// and optionally forwarded to Slack/email by the caller (n8n).
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = getSupabaseServiceClient();
    const stale = await getStaleCompanies(client);
    return NextResponse.json({
      count: stale.length,
      companies: stale.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        ownerEmail: c.ownerEmail,
        idleDays: c.idleDays,
        slaDays: c.slaDays,
        lastActivityAt: c.lastActivityAt,
      })),
    });
  } catch (err) {
    console.error("[cron/crm-idle] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
