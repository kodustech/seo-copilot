import { NextResponse } from "next/server";

import { startResearchJob } from "@/lib/research/runner";
import { getSupabaseUserClient } from "@/lib/supabase-server";

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

    const kind =
      body.kind === "people" ||
      body.kind === "full" ||
      body.kind === "ai_column"
        ? body.kind
        : "research";

    const started = startResearchJob(kind, {
      tableId: id,
      rowIds: Array.isArray(body.rowIds) ? body.rowIds : undefined,
      userEmail,
      force: Boolean(body.force),
      onlyIfPass: body.onlyIfPass !== false,
      aiPrompt: typeof body.aiPrompt === "string" ? body.aiPrompt : undefined,
      enrichPeople: Boolean(body.enrichPeople),
    });

    if (!started) {
      return NextResponse.json(
        { error: "A research job is already running" },
        { status: 409 },
      );
    }

    return NextResponse.json({ started: true, kind }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
