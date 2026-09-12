import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  addFeedback,
  addSkill,
  listFeedback,
  listSkillNotes,
  removeSkill,
} from "@/lib/influencer/feedback";
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
      listSkillNotes(client, id),
    ]);
    return NextResponse.json({ feedback, skills });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Leave the persona a note, or write a rule for it directly.
 *
 * The two are not the same thing and the distinction is the point. Feedback is
 * read once on the next shift and the persona decides what, if anything, to
 * keep from it. A skill is a rule that reaches every shift from now on. Writing
 * one by hand is for the cases where the persona has no shifts yet to learn
 * from, or where the rule is not negotiable.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    if (body.action === "add_skill") {
      const skill = typeof body.skill === "string" ? body.skill.trim() : "";
      if (skill.length < 3) {
        return NextResponse.json(
          { error: "A rule needs at least a few words." },
          { status: 400 },
        );
      }
      await addSkill(client, id, skill.slice(0, 1000));
      const skills = await listSkillNotes(client, id);
      return NextResponse.json({ skills });
    }

    const text = typeof body.body === "string" ? body.body : "";
    if (!text.trim()) {
      return NextResponse.json({ error: "Write something first." }, { status: 400 });
    }

    const feedback = await addFeedback(client, id, text, userEmail);
    return NextResponse.json({ feedback });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Drop a rule the persona should stop applying. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { client } = await getSupabaseUserClient(req.headers.get("authorization"));
    const { id } = await ctx.params;
    const skillId = new URL(req.url).searchParams.get("skill_id");
    if (!skillId) {
      return NextResponse.json({ error: "skill_id is required." }, { status: 400 });
    }

    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    await removeSkill(client, id, skillId);
    const skills = await listSkillNotes(client, id);
    return NextResponse.json({ skills });
  } catch (error) {
    return errorResponse(error);
  }
}
