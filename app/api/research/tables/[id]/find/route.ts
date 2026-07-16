import { NextResponse } from "next/server";

import { startResearchJob } from "@/lib/research/runner";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * Find ICP candidates (by region + hiring sources) and score them.
 * Long-running → 202 + poll /api/research/status.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    const market =
      body.market === "brazil" || body.market === "global"
        ? body.market
        : "global";
    const size =
      body.size === "small" ||
      body.size === "mid" ||
      body.size === "large" ||
      body.size === "any"
        ? body.size
        : "mid";
    const maxCompanies =
      typeof body.maxCompanies === "number" ? body.maxCompanies : 12;
    const focus =
      typeof body.focus === "string" && body.focus.trim()
        ? body.focus.trim()
        : null;

    const started = startResearchJob("find", {
      tableId: id,
      userEmail,
      market,
      size,
      maxCompanies,
      focus,
      researchAfterFind: body.researchAfter !== false,
    });

    if (!started) {
      return NextResponse.json(
        { error: "A research job is already running" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { started: true, kind: "find", market, size, maxCompanies },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
