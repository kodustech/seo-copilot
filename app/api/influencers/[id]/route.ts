import { NextResponse } from "next/server";

import { withUser } from "@/lib/db";
import { getSupabaseUserClient } from "@/lib/supabase-server";

import { listActivities } from "@/lib/influencer/drizzle/activities";
import {
  getPersona,
  listChannelsForPersona,
  updatePersona,
  type PersonaPatch,
} from "@/lib/influencer/drizzle/personas";
import {
  influencerTableMissingMessage,
  normalizePersonaStatus,
} from "@/lib/influencer/types";

export const maxDuration = 60;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Internal error";
  const missing = influencerTableMissingMessage(error);
  if (missing) {
    return NextResponse.json({ error: missing }, { status: 500 });
  }
  if (message.toLowerCase().includes("token") || message === "Unauthorized") {
    return unauthorized(message);
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;

    const payload = await withUser({ email: userEmail }, async (tx) => {
      const persona = await getPersona(tx, id);
      if (!persona) return null;
      const [channels, activities] = await Promise.all([
        listChannelsForPersona(tx, id),
        listActivities(tx, { persona_id: id, limit: 100 }),
      ]);
      return { ...persona, channels, activities };
    });

    if (!payload) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }
    return NextResponse.json({ persona: payload });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const patch: PersonaPatch = {};
    const assignText = (
      key: keyof PersonaPatch,
      value: unknown,
      nullable = true,
    ) => {
      if (typeof value === "string") {
        (patch as Record<string, unknown>)[key] = value;
      } else if (value === null && nullable) {
        (patch as Record<string, unknown>)[key] = null;
      }
    };

    assignText("display_name", body.display_name, false);
    assignText("bio", body.bio, false);
    assignText("avatar_url", body.avatar_url);
    assignText("backstory", body.backstory, false);
    assignText("disclosure", body.disclosure, false);
    assignText("beat", body.beat, false);
    assignText("tone", body.tone);
    assignText("writing_guidelines", body.writing_guidelines);

    for (const key of [
      "preferred_words",
      "forbidden_words",
      "allowed_topics",
      "forbidden_topics",
    ] as const) {
      if (Array.isArray(body[key])) {
        patch[key] = (body[key] as unknown[]).filter(
          (item): item is string => typeof item === "string",
        );
      }
    }

    if (body.content_config && typeof body.content_config === "object") {
      patch.content_config = body.content_config as Record<string, unknown>;
    }

    const status = normalizePersonaStatus(body.status);
    if (status) patch.status = status;

    const persona = await withUser({ email: userEmail }, (tx) =>
      updatePersona(tx, id, patch),
    );

    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }
    return NextResponse.json({ persona });
  } catch (error) {
    return errorResponse(error);
  }
}
