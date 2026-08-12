import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import { getPersona, updatePersona } from "@/lib/influencer/personas";
import { cadenceOf, nextActionAt, runPersonaTick } from "@/lib/influencer/tick";
import { influencerTableMissingMessage, type Persona } from "@/lib/influencer/types";

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

function tickState(persona: Persona, now: Date) {
  const cadence = cadenceOf(persona);
  const next = nextActionAt(persona);
  const status =
    cadence === "off"
      ? "off"
      : next && new Date(next).getTime() > now.getTime()
        ? "waiting"
        : "due";
  return {
    cadence,
    status,
    next_action_at: next,
    last_note:
      typeof persona.content_config.last_note === "string"
        ? persona.content_config.last_note
        : null,
    last_tick_at:
      typeof persona.content_config.last_tick_at === "string"
        ? persona.content_config.last_tick_at
        : null,
    last_session_id:
      typeof persona.content_config.last_session_id === "string"
        ? persona.content_config.last_session_id
        : null,
  };
}

/** The persona's autonomy state: cadence + what it's doing / when it acts next. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(req.headers.get("authorization"));
    const { id } = await ctx.params;
    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }
    return NextResponse.json(tickState(persona, new Date()));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Set the autonomy cadence, or run a shift right now. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(req.headers.get("authorization"));
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    if (body.action === "set_cadence") {
      const cadence =
        body.cadence === "daily" || body.cadence === "weekly" ? body.cadence : "off";
      // Turning autonomy on makes it due immediately (next heartbeat picks it up).
      const content_config: Record<string, unknown> = {
        ...persona.content_config,
        agent_cadence: cadence,
      };
      if (cadence !== "off" && !nextActionAt(persona)) {
        content_config.next_action_at = new Date().toISOString();
      }
      const updated = await updatePersona(client, id, { content_config });
      return NextResponse.json(tickState(updated ?? persona, new Date()));
    }

    if (body.action === "act_now") {
      const result = await runPersonaTick({ client, persona, now: new Date() });
      const refreshed = await getPersona(client, id);
      return NextResponse.json({
        result,
        ...tickState(refreshed ?? persona, new Date()),
      });
    }

    return NextResponse.json(
      { error: "action must be 'set_cadence' or 'act_now'." },
      { status: 400 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
