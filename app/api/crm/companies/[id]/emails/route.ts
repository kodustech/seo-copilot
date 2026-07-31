import { NextResponse } from "next/server";

import { getCompanyEmailTimeline } from "@/lib/crm-emails";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

export const maxDuration = 60;

/**
 * GET — live Gmail search across all mailboxes with gmail.readonly.
 * Query built from company domain + CRM contact emails.
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
    // Service role for mailbox secrets + token refresh.
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
