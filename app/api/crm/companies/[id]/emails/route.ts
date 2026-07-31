import { NextResponse } from "next/server";

import { getCompanyEmailTimeline } from "@/lib/crm-emails";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

/**
 * GET — email history for a CRM company (sequence outbound + Gmail reply inbox).
 * Read-only. Match by domain, CRM contact emails, enrollment company name.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    // Service role so we can join outreach tables without RLS edge cases.
    const client = getSupabaseServiceClient();
    const timeline = await getCompanyEmailTimeline(client, id);
    if (!timeline) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(timeline);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to load email history",
      },
      { status: 500 },
    );
  }
}
