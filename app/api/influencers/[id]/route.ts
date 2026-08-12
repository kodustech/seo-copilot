import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import { listActivities } from "@/lib/influencer/activities";
import {
  getPersona,
  listChannelsForPersona,
  updatePersona,
  type PersonaPatch,
} from "@/lib/influencer/personas";
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
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;

    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }
    const [channels, activities] = await Promise.all([
      listChannelsForPersona(client, id),
      listActivities(client, { persona_id: id, limit: 100 }),
    ]);

    return NextResponse.json({ persona: { ...persona, channels, activities } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
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
        const trimmed = value.trim();
        // Required fields can be changed but never emptied — POST enforces
        // non-empty on create and PATCH must not undo that. For nullable
        // fields a whitespace-only string means null, not three spaces.
        if (!trimmed && !nullable) return;
        (patch as Record<string, unknown>)[key] = trimmed ? value : null;
      } else if (value === null && nullable) {
        (patch as Record<string, unknown>)[key] = null;
      }
    };

    assignText("display_name", body.display_name, false);
    assignText("bio", body.bio, false);
    assignText("avatar_url", body.avatar_url);
    assignText("backstory", body.backstory, false);
    // Disclosure is optional — the creator decides whether the persona is
    // openly AI, and can clear it later (nullable).
    assignText("disclosure", body.disclosure);
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

    const persona = await updatePersona(client, id, patch);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }
    return NextResponse.json({ persona });
  } catch (error) {
    return errorResponse(error);
  }
}
