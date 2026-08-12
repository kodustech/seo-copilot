import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  getChannel,
  updateChannel,
  type ChannelPatch,
} from "@/lib/influencer/personas";
import {
  influencerTableMissingMessage,
  normalizeAutomationLevel,
  normalizeChannelStatus,
} from "@/lib/influencer/types";

export const maxDuration = 60;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
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

    const patch: ChannelPatch = {};

    if (typeof body.external_handle === "string" || body.external_handle === null) {
      patch.external_handle = body.external_handle;
    }
    const automationLevel = normalizeAutomationLevel(body.automation_level);
    if (automationLevel) patch.automation_level = automationLevel;

    if (typeof body.max_posts_per_day === "number") {
      patch.max_posts_per_day = Math.max(0, Math.floor(body.max_posts_per_day));
    }
    if (typeof body.max_replies_per_day === "number") {
      patch.max_replies_per_day = Math.max(0, Math.floor(body.max_replies_per_day));
    }
    if (typeof body.credentials_ref === "string" || body.credentials_ref === null) {
      patch.credentials_ref = body.credentials_ref;
    }
    if (body.channel_config && typeof body.channel_config === "object") {
      patch.channel_config = body.channel_config as Record<string, unknown>;
    }
    const status = normalizeChannelStatus(body.status);
    if (status) patch.status = status;

    // A publishing channel can't go active without a linked credential — the
    // publisher would just fail at runtime. /connect is the path that links it
    // (and activates). Draft-only / manual channels never publish, so they
    // activate freely.
    if (patch.status === "active") {
      const current = await getChannel(client, id);
      if (!current) {
        return NextResponse.json({ error: "Channel not found" }, { status: 404 });
      }
      const needsCredential =
        current.publish_via === "post_bridge" || current.publish_via === "api";
      // Validate the state the write will actually persist: updateChannel does
      // a blind .update(patch), so channel_config is REPLACED (not merged) when
      // the patch carries it. Merging here would pass the check while the write
      // silently drops post_bridge_account_id.
      const config = patch.channel_config ?? current.channel_config;
      const credentialsRef =
        patch.credentials_ref !== undefined ? patch.credentials_ref : current.credentials_ref;
      const hasCredential =
        (typeof credentialsRef === "string" && credentialsRef.length > 0) ||
        config.post_bridge_account_id != null;
      if (needsCredential && !hasCredential) {
        return NextResponse.json(
          { error: "Connect a credential before activating this channel." },
          { status: 400 },
        );
      }
    }

    const channel = await updateChannel(client, id, patch);
    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }
    return NextResponse.json({ channel });
  } catch (error) {
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
}
