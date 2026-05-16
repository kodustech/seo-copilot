import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { batchUpdateMentionStatus } from "@/lib/social-monitoring";
import type { MentionStatus } from "@/lib/social-monitoring";

const validStatuses = new Set(["new", "contacted", "replied", "dismissed"]);

const MAX_BATCH_SIZE = 200;

function authenticateUser(authHeader: string | null) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase not configured");

  const token = authHeader?.replace("Bearer ", "");
  if (!token) throw new Error("Missing auth token");

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * Bulk-update the status field across multiple mentions in one request.
 *
 * Body shape: `{ ids: string[], status: MentionStatus }`
 *
 * Capped at MAX_BATCH_SIZE ids per call to avoid runaway updates triggered by
 * a UI bug or a curl typo.
 */
export async function POST(req: Request) {
  try {
    authenticateUser(req.headers.get("authorization"));

    const body = await req.json();
    const ids = Array.isArray(body?.ids) ? (body.ids as string[]) : null;
    const status = typeof body?.status === "string" ? body.status : null;

    if (!ids || ids.length === 0) {
      return NextResponse.json(
        { error: "Provide a non-empty `ids` array." },
        { status: 400 },
      );
    }

    if (ids.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        {
          error: `Batch size ${ids.length} exceeds max of ${MAX_BATCH_SIZE}. Paginate the request.`,
        },
        { status: 400 },
      );
    }

    if (!status || !validStatuses.has(status)) {
      return NextResponse.json(
        {
          error: `Invalid status. Must be one of: ${[...validStatuses].join(", ")}`,
        },
        { status: 400 },
      );
    }

    const serviceClient = getSupabaseServiceClient();
    const updated = await batchUpdateMentionStatus(
      serviceClient,
      ids,
      status as MentionStatus,
    );

    return NextResponse.json({ updated, requested: ids.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status =
      message.includes("auth") || message.includes("token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
