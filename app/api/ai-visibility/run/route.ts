import { NextResponse } from "next/server";

import { isDataForSeoConfigured, runAiVisibility } from "@/lib/ai-visibility";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Ask now, outside the weekly schedule. Body: { promptIds?: string[], force?:
 * boolean }. Prompts already asked today are skipped unless force is set, so
 * a click after a partial failure only fills the gaps.
 */
export async function POST(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  if (!isDataForSeoConfigured()) {
    return NextResponse.json({ error: "DataForSEO is not configured (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const summary = await runAiVisibility(client, {
      promptIds: Array.isArray(body.promptIds) ? body.promptIds.map(String) : undefined,
      force: body.force === true,
    });
    return NextResponse.json({ summary });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
