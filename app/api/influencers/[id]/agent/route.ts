import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import { runInfluencerAgentSession } from "@/lib/influencer/agent";
import { getPersona } from "@/lib/influencer/personas";
import { listSessions } from "@/lib/influencer/sessions";
import { influencerTableMissingMessage } from "@/lib/influencer/types";

// Agent sessions do real multi-step work; give them room.
export const maxDuration = 300;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Internal error";
  const missing = influencerTableMissingMessage(error);
  if (missing) return NextResponse.json({ error: missing }, { status: 500 });
  if (message.toLowerCase().includes("token") || message === "Unauthorized") {
    return unauthorized(message);
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

/** List this persona's agent sessions (newest first). */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const sessions = await listSessions(client, id, 50);
    return NextResponse.json({ sessions });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Kick off a manual agent session with a goal (human-initiated trigger). */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!goal) {
      return NextResponse.json(
        { error: "goal is required — tell the persona what to do." },
        { status: 400 },
      );
    }

    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    const result = await runInfluencerAgentSession({
      client,
      persona,
      goal,
      trigger: "manual",
      createdBy: userEmail,
    });
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
