import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import { addFeedback, listFeedback, listSkills } from "@/lib/influencer/feedback";
import { getPersona } from "@/lib/influencer/personas";
import { influencerTableMissingMessage } from "@/lib/influencer/types";

export const maxDuration = 30;

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Internal error";
  const missing = influencerTableMissingMessage(error);
  if (missing) return NextResponse.json({ error: missing }, { status: 500 });
  if (message === "Unauthorized" || message.toLowerCase().includes("token")) {
    return NextResponse.json({ error: message }, { status: 401 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Feedback history + the skills the persona has distilled from it. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { client } = await getSupabaseUserClient(req.headers.get("authorization"));
    const { id } = await ctx.params;
    const [feedback, skills] = await Promise.all([
      listFeedback(client, id),
      listSkills(client, id),
    ]);
    return NextResponse.json({ feedback, skills });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Leave the persona a note. It reads new feedback on its next shift. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = typeof body.body === "string" ? body.body : "";
    if (!text.trim()) {
      return NextResponse.json({ error: "Write something first." }, { status: 400 });
    }

    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    const feedback = await addFeedback(client, id, text, userEmail);
    return NextResponse.json({ feedback });
  } catch (error) {
    return errorResponse(error);
  }
}
