import { NextResponse } from "next/server";

import { discoverContacts } from "@/lib/contact-discovery";
import { getSupabaseUserClient } from "@/lib/supabase-server";

// Contact discovery does network work + an LLM call; budget enough time so
// the request doesn't get killed mid-extraction.
export const maxDuration = 60;

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

  const domain = typeof body.domain === "string" ? body.domain : null;
  const articleUrl =
    typeof body.articleUrl === "string" && body.articleUrl.trim()
      ? body.articleUrl
      : undefined;

  if (!domain || !domain.trim()) {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }

  try {
    const result = await discoverContacts({ domain, articleUrl });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[discover-contacts] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
