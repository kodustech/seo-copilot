import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { updateMentionStatus } from "@/lib/social-monitoring";
import type { MentionStatus } from "@/lib/social-monitoring";

const validStatuses = new Set(["new", "contacted", "replied", "dismissed"]);

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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Verify user is authenticated
    authenticateUser(req.headers.get("authorization"));

    const { id } = await params;
    const body = await req.json();
    const { status } = body as { status: string };

    if (!status || !validStatuses.has(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${[...validStatuses].join(", ")}` },
        { status: 400 },
      );
    }

    // Use service client for the update (RLS only allows select for authenticated)
    const serviceClient = getSupabaseServiceClient();
    const mention = await updateMentionStatus(
      serviceClient,
      id,
      status as MentionStatus,
    );

    return NextResponse.json({ mention });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("auth") || message.includes("token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
