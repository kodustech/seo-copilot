import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  deleteChannelCredential,
  setChannelCredential,
} from "@/lib/influencer/credentials";
import { deleteContext, releaseSession, startLoginSession } from "@/lib/influencer/browser";
import {
  MEDIUM_CONTEXT_KEY,
  MEDIUM_CREDENTIAL_MARKER,
  MEDIUM_SIGNIN_URL,
  checkMediumSession,
  mediumContextId,
} from "@/lib/influencer/medium";
import { getChannel, listChannelsForPersona, updateChannel } from "@/lib/influencer/personas";
import {
  CONTENT_KEY_SENTINEL,
  CONTENT_KEY_VAULT,
  DEFAULT_BLOG_API_URL,
  blogDestination,
  findBlogKeyClash,
  isDefaultBlogSite,
} from "@/lib/influencer/publish";
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
 * - blog: the site's content API, source base and key.
 * - Medium: a person signs in through a live remote browser; the persistent
 *   context that login lands in is the credential.
 * - hand-posted channels (reddit, hackernoon, …): nothing to link — active
 *   means "draft for me".
 * Every path flips the channel to `active`.
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

    if (channel.platform === "blog") {
      // A farm site connects here: its content API, where its markdown can be
      // read back, and its own key. Adding a site used to mean an env var and a
      // deploy; the key belongs to the site, so it belongs with the channel.
      const apiUrl = typeof body.api_url === "string" ? body.api_url.trim().replace(/\/+$/, "") : "";
      const sourceBase =
        typeof body.source_base === "string" ? body.source_base.trim().replace(/\/+$/, "") : "";
      const key = typeof body.key === "string" ? body.key.trim() : "";

      const httpsOnly = (value: string, field: string) => {
        if (!value) return null;
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          return `${field} is not a valid URL.`;
        }
        // The article and the key travel over this, and the source read comes
        // back into the model's context — neither goes over plaintext.
        return parsed.protocol === "https:" ? null : `${field} must be https.`;
      };
      const urlError = httpsOnly(apiUrl, "api_url") ?? httpsOnly(sourceBase, "source_base");
      if (urlError) return NextResponse.json({ error: urlError }, { status: 400 });

      // Without a key of its own a channel borrows the shared one, and that one
      // only ever serves the default site. Saying "connected" here and failing
      // at publish time would be a form that lies.
      // Where this channel will actually publish once connected. Both checks
      // below judge this, never the request on its own.
      const destination = blogDestination(channel, apiUrl);

      if (!key) {
        if (!isDefaultBlogSite(destination)) {
          return NextResponse.json(
            {
              error: `A blog on ${destination} needs its own content API key — the shared CONTENT_API_KEY only publishes to ${DEFAULT_BLOG_API_URL}.`,
            },
            { status: 400 },
          );
        }
        if (!process.env.CONTENT_API_KEY?.trim()) {
          return NextResponse.json(
            { error: `Set CONTENT_API_KEY to publish to ${DEFAULT_BLOG_API_URL}, or give this blog its own key.` },
            { status: 400 },
          );
        }
      }
      // The vault holds one row per persona per provider, so a second farm
      // channel on this persona would overwrite the first site's key while both
      // kept the vault marker — and whichever key was written last would then be
      // sent to both hosts. One persona per site is the farm's shape anyway;
      // this makes it a refusal instead of a silent swap.
      if (key) {
        const siblings = await listChannelsForPersona(client, channel.persona_id);
        const clash = findBlogKeyClash(siblings, { channelId: id, destination });
        if (clash) {
          return NextResponse.json(
            {
              error: `This persona already keeps a blog key for ${String(clash.channel_config.blog_api_url ?? "another site")}, and the vault holds one per persona. Give the second site its own persona, or disconnect that channel first.`,
            },
            { status: 400 },
          );
        }
      }
      if (key) {
        await setChannelCredential(client, {
          persona_id: channel.persona_id,
          platform: "blog",
          key,
          label: apiUrl ? new URL(apiUrl).hostname : null,
          created_by: userEmail,
        });
      }
      const updated = await updateChannel(client, id, {
        status: "active",
        credentials_ref: key ? CONTENT_KEY_VAULT : CONTENT_KEY_SENTINEL,
        channel_config: {
          ...channel.channel_config,
          ...(apiUrl ? { blog_api_url: apiUrl } : {}),
          ...(sourceBase ? { blog_source_base: sourceBase } : {}),
        },
      });
      return NextResponse.json({ connected: true, platform: "blog", channel: updated });
    }

    if (channel.platform === "medium") {
      // Step 1: open a browser a person can sign in with. The context it lands
      // in is remembered on the channel so step 2 can only confirm THAT one.
      if (body.start_login === true) {
        // The proxy choice is part of the login: a session signed in from a
        // residential IP and reused from a datacenter one reads as another
        // device. An explicit boolean wins; otherwise the stored choice holds.
        // Written as a boolean either way, so "off" is a value, not a missing key.
        const proxies =
          typeof body.proxies === "boolean" ? body.proxies : channel.channel_config.proxies === true;
        const login = await startLoginSession(MEDIUM_SIGNIN_URL, {
          name: `medium-${channel.persona_id.slice(0, 8)}-${Date.now()}`,
          proxies,
        });

        // "Open the login again" must not orphan the previous attempt: a
        // context nobody points at any more still holds whatever login the
        // person completed in it. Retired only now, after the replacement
        // exists — a failed replacement must leave the previous attempt usable.
        const prevContext =
          typeof channel.channel_config.pending_context_id === "string"
            ? channel.channel_config.pending_context_id
            : "";
        const prevSession =
          typeof channel.channel_config.pending_session_id === "string"
            ? channel.channel_config.pending_session_id
            : "";
        if (prevSession) await releaseSession(prevSession);
        if (prevContext && prevContext !== login.context_id) await deleteContext(prevContext);

        await updateChannel(client, id, {
          channel_config: {
            ...channel.channel_config,
            pending_context_id: login.context_id,
            pending_session_id: login.session_id,
            proxies,
          },
        });
        return NextResponse.json({ login });
      }

      // Step 2: the person says they are signed in. Release the login session
      // so the context is saved, then open it and see whether Medium agrees.
      const pending =
        typeof channel.channel_config.pending_context_id === "string"
          ? channel.channel_config.pending_context_id
          : "";
      const contextId =
        (typeof body.browserbase_context_id === "string" && body.browserbase_context_id.trim()) ||
        pending;
      if (!contextId) {
        return NextResponse.json(
          { error: "Start the Medium login first, sign in through the live browser, then confirm." },
          { status: 400 },
        );
      }
      const pendingSession =
        typeof channel.channel_config.pending_session_id === "string"
          ? channel.channel_config.pending_session_id
          : "";
      if (pendingSession && contextId === pending) {
        await releaseSession(pendingSession);
        // The context write-back is not instant; a short grace keeps the
        // check from reading the jar before the login is in it.
        await new Promise((r) => setTimeout(r, 4_000));
      }
      const proxies =
        typeof body.proxies === "boolean" ? body.proxies : channel.channel_config.proxies === true;
      const check = await checkMediumSession(contextId, { proxies });
      if (!check.loggedIn) {
        return NextResponse.json(
          {
            error: `That browser is not signed in to Medium (it landed on ${check.landedOn}). Open the login again, finish signing in inside the live browser, then confirm.`,
          },
          { status: 400 },
        );
      }
      const config: Record<string, unknown> = {
        ...channel.channel_config,
        [MEDIUM_CONTEXT_KEY]: contextId,
        proxies,
      };
      delete config.pending_context_id;
      delete config.pending_session_id;
      const updated = await updateChannel(client, id, {
        status: "active",
        publish_via: "browser",
        credentials_ref: MEDIUM_CREDENTIAL_MARKER,
        // Medium was draft-only before it could publish. Now a person approves
        // each import; "auto" is still theirs to grant later.
        ...(channel.automation_level === "draft_only" ? { automation_level: "approve_first" as const } : {}),
        channel_config: config,
      });
      return NextResponse.json({ connected: true, platform: "medium", channel: updated });
    }

    if (channel.publish_via === "manual") {
      // Nothing to link. Active is the person saying: draft for this one, I
      // will post it and mark it published.
      const updated = await updateChannel(client, id, { status: "active" });
      return NextResponse.json({ connected: true, platform: channel.platform, channel: updated });
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
    } else if (channel.platform === "blog") {
      // The stored key is NOT deleted here, unlike dev.to's. The vault row is
      // keyed by persona and provider, so it is shared by every blog channel of
      // this persona — deleting it on one channel's disconnect would take the
      // sibling's key with it, and the sibling would keep saying it is
      // connected while every publish failed.
      //
      // Nothing is left exposed by keeping it: credentials_ref goes null here,
      // and resolveBlogApiKey only reads the vault when it says vault:blog. A
      // reconnect rewrites the marker either way.
      await updateChannel(client, id, {
        status: "pending_setup",
        credentials_ref: null,
      });
    } else if (channel.platform === "medium") {
      // The login lives in the Browserbase context; forgetting the channel's
      // pointer without deleting the context would leave a signed-in browser
      // nobody can see from the app.
      const contextId = mediumContextId(channel);
      if (contextId) await deleteContext(contextId);
      const config = { ...channel.channel_config };
      delete config[MEDIUM_CONTEXT_KEY];
      delete config.pending_context_id;
      delete config.pending_session_id;
      await updateChannel(client, id, {
        status: "pending_setup",
        credentials_ref: null,
        channel_config: config,
      });
    } else if (channel.publish_via === "manual") {
      await updateChannel(client, id, { status: "pending_setup" });
    }

    return NextResponse.json({ connected: false });
  } catch (error) {
    return fail(error);
  }
}
