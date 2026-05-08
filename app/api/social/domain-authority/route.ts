import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { getOpenPageRank } from "@/lib/open-pagerank";

// Open PageRank scores are stable enough across a day that an in-memory
// cache is the right call: avoids burning the daily 1000-request quota on
// every page load. Cache lives on the Node process; serverless cold starts
// will repopulate it.
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const cache = new Map<string, { score: number | null; expiresAt: number }>();

const MAX_DOMAINS_PER_REQUEST = 100;

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

function normalizeDomain(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];
  if (!cleaned || !cleaned.includes(".")) return null;
  return cleaned;
}

export async function POST(req: Request) {
  // Auth gate — protects the daily quota from anonymous traffic.
  try {
    const client = getSupabaseUserClient(req.headers.get("authorization"));
    const { error } = await client.auth.getUser();
    if (error) throw new Error(error.message);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  let body: { domains?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!Array.isArray(body.domains)) {
    return NextResponse.json(
      { error: "domains must be an array of strings" },
      { status: 400 },
    );
  }

  const requested = (body.domains as unknown[])
    .filter((d): d is string => typeof d === "string")
    .map(normalizeDomain)
    .filter((d): d is string => d !== null);

  const unique = Array.from(new Set(requested)).slice(0, MAX_DOMAINS_PER_REQUEST);

  const now = Date.now();
  const result: Record<string, number | null> = {};
  const toFetch: string[] = [];

  for (const domain of unique) {
    const cached = cache.get(domain);
    if (cached && cached.expiresAt > now) {
      result[domain] = cached.score;
    } else {
      toFetch.push(domain);
    }
  }

  if (toFetch.length > 0) {
    const fresh = await getOpenPageRank(toFetch);
    for (const domain of toFetch) {
      const score = fresh[domain] ?? null;
      result[domain] = score;
      cache.set(domain, { score, expiresAt: now + TTL_MS });
    }
  }

  return NextResponse.json({ scores: result });
}
