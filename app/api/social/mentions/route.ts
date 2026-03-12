import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { listMentions, getMentionStats } from "@/lib/social-monitoring";
import type { SocialPlatform, Relevance, MentionStatus } from "@/lib/social-monitoring";

function getSupabaseUserClient(authHeader: string | null) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase not configured");

  const token = authHeader?.replace("Bearer ", "");
  if (!token) throw new Error("Missing auth token");

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

const validPlatforms = new Set(["reddit", "twitter", "linkedin"]);
const validRelevance = new Set(["high", "medium", "low"]);
const validStatus = new Set(["new", "contacted", "replied", "dismissed"]);

export async function GET(req: Request) {
  try {
    const client = getSupabaseUserClient(req.headers.get("authorization"));
    const url = new URL(req.url);

    const platform = url.searchParams.get("platform");
    const relevance = url.searchParams.get("relevance");
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit")) || 100;
    const offset = Number(url.searchParams.get("offset")) || 0;

    const filters = {
      ...(platform && validPlatforms.has(platform)
        ? { platform: platform as SocialPlatform }
        : {}),
      ...(relevance && validRelevance.has(relevance)
        ? { relevance: relevance as Relevance }
        : {}),
      ...(status && validStatus.has(status)
        ? { status: status as MentionStatus }
        : {}),
      limit,
      offset,
    };

    const [mentions, stats] = await Promise.all([
      listMentions(client, filters),
      getMentionStats(client),
    ]);

    return NextResponse.json({ mentions, stats });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
