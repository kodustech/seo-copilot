import { NextResponse } from "next/server";

import { deletePrompt, updatePrompt } from "@/lib/ai-visibility";
import { getSupabaseUserClient } from "@/lib/supabase-server";

async function auth(req: Request) {
  return getSupabaseUserClient(req.headers.get("authorization"));
}

/** Edit text, language, tags or active. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const prompt = await updatePrompt(client, id, {
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
      ...(typeof body.language === "string" ? { language: body.language } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
      ...(typeof body.active === "boolean" ? { active: body.active } : {}),
    });
    return NextResponse.json({ prompt });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}

/** Remove a prompt and its runs. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let client;
  try {
    ({ client } = await auth(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await deletePrompt(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
