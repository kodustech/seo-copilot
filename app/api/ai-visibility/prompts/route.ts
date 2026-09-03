import { NextResponse } from "next/server";

import { createPrompt, listPrompts } from "@/lib/ai-visibility";
import { getSupabaseUserClient } from "@/lib/supabase-server";

async function auth(req: Request) {
  return getSupabaseUserClient(req.headers.get("authorization"));
}

/** Every prompt, active or not. */
export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ prompts: await listPrompts(client) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

/** Add a prompt. Body: { prompt, language?, tags?, active? }. */
export async function POST(req: Request) {
  let client: Awaited<ReturnType<typeof auth>>["client"];
  let userEmail: string;
  try {
    ({ client, userEmail } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const prompt = await createPrompt(client, {
      prompt: String(body.prompt ?? ""),
      language: typeof body.language === "string" ? body.language : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      createdByEmail: userEmail,
    });
    return NextResponse.json({ prompt }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
