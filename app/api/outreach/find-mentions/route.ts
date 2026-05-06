import { NextResponse } from "next/server";

import { findUnlinkedBrandMentions } from "@/lib/brand-mentions";
import { getSupabaseUserClient } from "@/lib/supabase-server";

// Worst-case ~2.5min (30 candidates × ~5s scrape+LLM). Cap maxDuration at 180s.
export const maxDuration = 180;

export async function POST(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const brand = typeof body.brand === "string" ? body.brand.trim() : "";
  const canonicalDomain =
    typeof body.canonicalDomain === "string"
      ? body.canonicalDomain.trim()
      : "";

  if (!brand || !canonicalDomain) {
    return NextResponse.json(
      { error: "brand and canonicalDomain are required" },
      { status: 400 },
    );
  }

  const daysBack =
    typeof body.daysBack === "number" ? body.daysBack : undefined;
  const numResults =
    typeof body.numResults === "number" ? body.numResults : undefined;
  const minRelevance =
    typeof body.minRelevance === "number" ? body.minRelevance : undefined;

  try {
    const out = await findUnlinkedBrandMentions({
      brand,
      canonicalDomain,
      daysBack,
      numResults,
      minRelevance,
    });
    return NextResponse.json(out);
  } catch (err) {
    console.error("[find-mentions] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
