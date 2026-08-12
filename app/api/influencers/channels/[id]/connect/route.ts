import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  deleteChannelCredential,
  setChannelCredential,
} from "@/lib/influencer/credentials";
import { getChannel, updateChannel } from "@/lib/influencer/personas";
import { influencerTableMissingMessage } from "@/lib/influencer/types";

export const maxDuration = 60;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "Internal error";
  const missing = influencerTableMissingMessage(error);
  if (missing) return NextResponse.json({ error: missing }, { status: 500 });
  if (message === "Unauthorized" || message.toLowerCase().includes("token")) {
    return unauthorized(message);
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Validate a dev.to API key by identifying its owner. */
async function validateDevtoKey(key: string): Promise<{ username: string }> {
  const res = await fetch("https://dev.to/api/users/me", {
    headers: { "api-key": key, Accept: "application/vnd.forem.api-v1+json" },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("dev.to rejected this API key.");
  if (!res.ok) throw new Error(`dev.to could not verify the key (HTTP ${res.status}).`);
  const body = (await res.json().catch(() => ({}))) as {
    username?: string;
    name?: string;
  };
  return { username: body.username || body.name || "connected" };
}

/**
 * Connect a channel for real publishing.
 * - dev.to: validate + store an API key in the encrypted vault.
 * - Post-Bridge channels (X, …): bind the persona's Post-Bridge account id.
 * Either path flips the channel to `active`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const channel = await getChannel(client, id);
    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    if (channel.platform === "devto") {
      const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
      if (!key) {
        return NextResponse.json(
          { error: "Paste the dev.to API key (Settings → Extensions → DEV API Keys)." },
          { status: 400 },
        );
      }
      const { username } = await validateDevtoKey(key);
      const { key_last4 } = await setChannelCredential(client, {
        persona_id: channel.persona_id,
        platform: "devto",
        key,
        label: username,
        created_by: userEmail,
      });
      const updated = await updateChannel(client, id, {
        status: "active",
        credentials_ref: "vault:devto",
      });
      return NextResponse.json({
        connected: true,
        platform: "devto",
        username,
        key_last4,
        channel: updated,
      });
    }

    if (channel.publish_via === "post_bridge") {
      const accountId = Number(body.post_bridge_account_id);
      if (!Number.isInteger(accountId) || accountId <= 0) {
        return NextResponse.json(
          { error: "Pick which Post-Bridge account this channel posts as." },
          { status: 400 },
        );
      }
      const updated = await updateChannel(client, id, {
        channel_config: {
          ...channel.channel_config,
          post_bridge_account_id: accountId,
        },
        status: "active",
      });
      return NextResponse.json({
        connected: true,
        platform: channel.platform,
        channel: updated,
      });
    }

    return NextResponse.json(
      {
        error: `"${channel.platform}" has no direct publishing integration yet — it stays draft-only.`,
      },
      { status: 400 },
    );
  } catch (error) {
    return fail(error);
  }
}

/** Disconnect: forget the credential/account and park the channel. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { client } = await getSupabaseUserClient(req.headers.get("authorization"));
    const { id } = await ctx.params;
    const channel = await getChannel(client, id);
    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    if (channel.platform === "devto") {
      await deleteChannelCredential(client, channel.persona_id, "devto");
      await updateChannel(client, id, {
        status: "pending_setup",
        credentials_ref: null,
      });
    } else if (channel.publish_via === "post_bridge") {
      const config = { ...channel.channel_config };
      delete config.post_bridge_account_id;
      await updateChannel(client, id, {
        channel_config: config,
        status: "pending_setup",
      });
    }

    return NextResponse.json({ connected: false });
  } catch (error) {
    return fail(error);
  }
}
