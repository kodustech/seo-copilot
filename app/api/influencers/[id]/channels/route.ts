import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import { createChannel, getPersona } from "@/lib/influencer/personas";
import {
  channelDefaults,
  influencerTableMissingMessage,
  normalizeChannelPlatform,
} from "@/lib/influencer/types";

/**
 * POST { platform } → { channel }: add a channel to an existing persona.
 * Channels used to be born only with the persona in the wizard, so a platform
 * added to the product later (YouTube) never reached the personas already
 * running. Same defaults the wizard uses; one channel per platform.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { client } = await getSupabaseUserClient(req.headers.get("authorization"));
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const platform = normalizeChannelPlatform(body.platform);
    if (!platform) {
      return NextResponse.json({ error: "platform is not one this tool publishes to." }, { status: 400 });
    }
    const persona = await getPersona(client, id);
    if (!persona) return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    const defaults = channelDefaults(platform);
    try {
      const channel = await createChannel(client, {
        persona_id: persona.id,
        platform,
        publish_via: defaults.publish_via,
        automation_level: defaults.automation_level,
        max_posts_per_day: defaults.max_posts_per_day,
        max_replies_per_day: defaults.max_replies_per_day,
      });
      return NextResponse.json({ channel }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/duplicate key|unique/i.test(message)) {
        return NextResponse.json({ error: "This persona already has that channel." }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    const missing = influencerTableMissingMessage(error);
    if (missing) return NextResponse.json({ error: missing }, { status: 500 });
    if (message === "Unauthorized" || message.toLowerCase().includes("token")) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    // The database's own wording (table, constraint names) stays in the log.
    // Only the message: client errors carry request context, auth header included.
    console.error("[influencers] add channel failed:", { message });
    return NextResponse.json({ error: "Could not add the channel." }, { status: 500 });
  }
}
