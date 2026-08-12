import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import { getPersona, updatePersona } from "@/lib/influencer/personas";
import { planPersona } from "@/lib/influencer/planner";
import { listTasks } from "@/lib/influencer/tasks";
import { influencerTableMissingMessage } from "@/lib/influencer/types";

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

/** The persona's backlog + its autonomy cadence. */
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
    const tasks = await listTasks(client, id, { limit: 200 });
    const cadence =
      persona.content_config.agent_cadence === "daily" ||
      persona.content_config.agent_cadence === "weekly"
        ? persona.content_config.agent_cadence
        : "off";
    return NextResponse.json({ tasks, cadence });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Plan now, or set the autonomy cadence. */
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
      const updated = await updatePersona(client, id, {
        content_config: { ...persona.content_config, agent_cadence: cadence },
      });
      return NextResponse.json({ cadence, ok: Boolean(updated) });
    }

    if (body.action === "plan") {
      const planned = await planPersona({ client, persona, now: new Date() });
      const tasks = await listTasks(client, id, { limit: 200 });
      return NextResponse.json({ planned, tasks });
    }

    return NextResponse.json(
      { error: "action must be 'plan' or 'set_cadence'." },
      { status: 400 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
