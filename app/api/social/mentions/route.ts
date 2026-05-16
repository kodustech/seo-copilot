import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { listMentions, getMentionStats } from "@/lib/social-monitoring";
import type {
  SocialPlatform,
  Relevance,
  MentionStatus,
  Intent,
} from "@/lib/social-monitoring";

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

const validPlatforms = new Set([
  "reddit",
  "twitter",
  "linkedin",
  "hackernews",
  "web",
  "github",
]);
const validRelevance = new Set(["high", "medium", "low"]);
const validStatus = new Set(["new", "contacted", "replied", "dismissed"]);
const validIntents = new Set([
  "asking_help",
  "complaining",
  "comparing_tools",
  "discussing",
  "sharing_experience",
  "backlink_opportunity",
  "competitor_listicle",
]);

/**
 * Accept either a full ISO 8601 timestamp ("2026-05-16T00:00:00Z") or a
 * date-only string ("2026-05-16") from the UI's <input type="date"> field.
 * Returns the ISO string, or null when the value is empty/invalid (in which
 * case the caller should drop the filter rather than reject the request).
 */
function parseDateParam(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export async function GET(req: Request) {
  // Auth — distinct from runtime errors so the UI can show 401 vs 500
  // separately. Previously every failure surfaced as 401, masking real bugs.
  let client;
  try {
    client = getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const url = new URL(req.url);

    const platform = url.searchParams.get("platform");
    const relevance = url.searchParams.get("relevance");
    const status = url.searchParams.get("status");
    const intent = url.searchParams.get("intent");
    const dateFrom = parseDateParam(url.searchParams.get("dateFrom"));
    const dateTo = parseDateParam(url.searchParams.get("dateTo"));
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
      ...(intent && validIntents.has(intent)
        ? { intent: intent as Intent }
        : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      limit,
      offset,
    };

    const [mentions, stats] = await Promise.all([
      listMentions(client, filters),
      getMentionStats(client),
    ]);

    return NextResponse.json({ mentions, stats });
  } catch (err) {
    console.error("[api/social/mentions] GET failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch" },
      { status: 500 },
    );
  }
}
