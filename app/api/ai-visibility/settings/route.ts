import { NextResponse } from "next/server";

import { AI_ENGINES, getSettings, updateSettings, type EngineConfig } from "@/lib/ai-visibility";
import { getSupabaseUserClient } from "@/lib/supabase-server";

async function auth(req: Request) {
  return getSupabaseUserClient(req.headers.get("authorization"));
}

export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ settings: await getSettings(client) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

/** Body: { weekday?, engines?: [{engine, model}], brandTerms?, competitorTerms? }. */
export async function PATCH(req: Request) {
  let client;
  try {
    ({ client } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const engines = Array.isArray(body.engines)
      ? (body.engines as Array<Record<string, unknown>>)
          .filter((e) => e && (AI_ENGINES as readonly string[]).includes(String(e.engine)))
          .map((e) => ({ engine: String(e.engine), model: typeof e.model === "string" ? e.model : "" }) as EngineConfig)
      : undefined;
    const settings = await updateSettings(client, {
      ...(typeof body.weekday === "number" ? { weekday: body.weekday } : {}),
      ...(engines ? { engines } : {}),
      ...(Array.isArray(body.brandTerms) ? { brandTerms: body.brandTerms.map(String) } : {}),
      ...(Array.isArray(body.competitorTerms) ? { competitorTerms: body.competitorTerms.map(String) } : {}),
    });
    return NextResponse.json({ settings });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
