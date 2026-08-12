import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import { listActivities } from "@/lib/influencer/activities";
import {
  createChannel,
  createPersona,
  listChannels,
  listPersonas,
  type CreateChannelInput,
} from "@/lib/influencer/personas";
import {
  influencerTableMissingMessage,
  normalizeAutomationLevel,
  normalizeChannelPlatform,
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

async function safeReadJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const [personas, channels, pendingDrafts] = await Promise.all([
      listPersonas(client),
      listChannels(client),
      listActivities(client, { statuses: ["draft"], limit: 500 }),
    ]);

    const pendingByPersona = new Map<string, number>();
    for (const draft of pendingDrafts) {
      pendingByPersona.set(
        draft.persona_id,
        (pendingByPersona.get(draft.persona_id) ?? 0) + 1,
      );
    }

    const channelsByPersona = new Map<string, typeof channels>();
    for (const channel of channels) {
      const bucket = channelsByPersona.get(channel.persona_id);
      if (bucket) bucket.push(channel);
      else channelsByPersona.set(channel.persona_id, [channel]);
    }

    const payload = personas.map((persona) => ({
      ...persona,
      channels: channelsByPersona.get(persona.id) ?? [],
      pending_drafts: pendingByPersona.get(persona.id) ?? 0,
    }));

    return NextResponse.json({ personas: payload });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const body = await safeReadJson(req);
    const text = (key: string) =>
      typeof body[key] === "string" ? (body[key] as string) : "";
    const list = (key: string) =>
      Array.isArray(body[key])
        ? (body[key] as unknown[]).filter(
            (item): item is string => typeof item === "string",
          )
        : [];

    if (!text("handle") || !text("display_name") || !text("bio")) {
      return NextResponse.json(
        { error: "handle, display_name and bio are required." },
        { status: 400 },
      );
    }
    if (!text("backstory") || !text("beat") || !text("disclosure")) {
      return NextResponse.json(
        { error: "backstory, beat and disclosure are required." },
        { status: 400 },
      );
    }

    const rawChannels = Array.isArray(body.channels)
      ? (body.channels as Record<string, unknown>[])
      : [];

    const created = await createPersona(client, {
      handle: text("handle"),
      display_name: text("display_name"),
      bio: text("bio"),
      avatar_url: text("avatar_url") || null,
      backstory: text("backstory"),
      disclosure: text("disclosure"),
      beat: text("beat"),
      tone: text("tone") || null,
      writing_guidelines: text("writing_guidelines") || null,
      preferred_words: list("preferred_words"),
      forbidden_words: list("forbidden_words"),
      allowed_topics: list("allowed_topics"),
      forbidden_topics: list("forbidden_topics"),
      content_config:
        body.content_config && typeof body.content_config === "object"
          ? (body.content_config as Record<string, unknown>)
          : {},
      created_by: userEmail,
    });

    const channels = [];
    for (const raw of rawChannels) {
      const platform = normalizeChannelPlatform(raw.platform);
      if (!platform) continue;
      const input: CreateChannelInput = {
        persona_id: created.id,
        platform,
        external_handle:
          typeof raw.external_handle === "string" ? raw.external_handle : null,
        publish_via:
          platform === "x"
            ? "post_bridge"
            : platform === "devto"
              ? "api"
              : platform === "blog"
                ? "n8n"
                : "manual",
        automation_level:
          normalizeAutomationLevel(raw.automation_level) ??
          (platform === "reddit" || platform === "hackernews" || platform === "medium"
            ? "draft_only"
            : "approve_first"),
      };
      channels.push(await createChannel(client, input));
    }

    return NextResponse.json(
      { persona: { ...created, channels, pending_drafts: 0 } },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
