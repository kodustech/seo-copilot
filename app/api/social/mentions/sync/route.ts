import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import {
  syncSocialMentions,
  type SocialPlatform,
} from "@/lib/social-monitoring";

export const maxDuration = 300;

const VALID_PLATFORMS = new Set<SocialPlatform>([
  "reddit",
  "twitter",
  "linkedin",
  "hackernews",
  "web",
  "github",
]);

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

// Parse the `platforms` query param. Accepts comma-separated values
// (?platforms=web,github) or a single value. Empty / missing / "all" means
// sync everything (legacy behavior).
function parsePlatformsParam(raw: string | null): SocialPlatform[] | undefined {
  if (!raw || raw === "all") return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  const valid = parts.filter((p): p is SocialPlatform =>
    VALID_PLATFORMS.has(p as SocialPlatform),
  );
  return valid.length > 0 ? valid : undefined;
}

export async function POST(req: Request) {
  const authenticated = await verifyAuth(req.headers.get("authorization"));
  if (!authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const platforms = parsePlatformsParam(url.searchParams.get("platforms"));

  try {
    const client = getSupabaseServiceClient();
    const result = await syncSocialMentions(client, { platforms });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[social/mentions/sync] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 },
    );
  }
}
