import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { syncSocialMentions } from "@/lib/social-monitoring";

export const maxDuration = 300;

async function verifyAuth(authHeader: string | null): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return false;

  const token = authHeader?.replace("Bearer ", "");
  if (!token) return false;

  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data } = await client.auth.getUser();
  return !!data.user;
}

export async function POST(req: Request) {
  const authenticated = await verifyAuth(req.headers.get("authorization"));
  if (!authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = getSupabaseServiceClient();
    const result = await syncSocialMentions(client);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[social/mentions/sync] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 },
    );
  }
}
