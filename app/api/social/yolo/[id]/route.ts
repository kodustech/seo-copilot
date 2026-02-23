import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { socialYoloTableMissingMessage } from "@/lib/social-yolo";

type PatchBody = Partial<{
  theme: string;
  platform: string;
  hook: string;
  content: string;
  cta: string;
  hashtags: string[];
  status: "draft" | "selected" | "discarded";
}>;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const body = await safeReadJson(req);
    const payload = normalizePatch(body);
    if (!Object.keys(payload).length) {
      return NextResponse.json(
        { error: "No valid fields to update." },
        { status: 400 },
      );
    }

    const { data, error } = await client
      .from("social_yolo_posts")
      .update(payload)
      .eq("id", id)
      .eq("user_email", userEmail)
      .select("*")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({ post: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    const missingMessage = socialYoloTableMissingMessage(error);
    if (missingMessage) {
      return NextResponse.json({ error: missingMessage }, { status: 500 });
    }
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function normalizePatch(body: PatchBody): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (typeof body.theme === "string" && body.theme.trim()) {
    payload.theme = body.theme.trim();
  }
  if (typeof body.platform === "string" && body.platform.trim()) {
    payload.platform = body.platform.trim();
  }
  if (typeof body.hook === "string") {
    payload.hook = normalizeMultiline(body.hook);
  }
  if (typeof body.content === "string" && body.content.trim()) {
    payload.content = normalizeMultiline(body.content);
  }
  if (typeof body.cta === "string") {
    payload.cta = normalizeMultiline(body.cta);
  }
  if (Array.isArray(body.hashtags)) {
    payload.hashtags = body.hashtags
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .map((tag) => {
        const withoutPrefix = tag.replace(/^#+/, "");
        return withoutPrefix ? `#${withoutPrefix}` : "";
      })
      .filter(Boolean);
  }
  if (
    body.status === "draft" ||
    body.status === "selected" ||
    body.status === "discarded"
  ) {
    payload.status = body.status;
  }

  if (Object.keys(payload).length > 0) {
    payload.updated_at = new Date().toISOString();
  }
  return payload;
}

function normalizeMultiline(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

async function safeReadJson(req: Request): Promise<PatchBody> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as PatchBody;
    }
    return {};
  } catch {
    return {};
  }
}
