/**
 * persona-publish: the persona's "body". The brain (generation/agent) only
 * writes drafts; every hard wall lives here, outside the model — channel
 * automation level, daily caps, forbidden topics, and the fleet-amplification
 * block. Worst case upstream is a bad draft in the queue, never a bad post
 * on the wire.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { scheduleSocialPost } from "@/lib/copilot";
import { decryptPersonaKey } from "@/lib/crypto/persona-secrets";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

import {
  claimActivityForPublishing,
  countPublishedToday,
  listDueForPublish,
  resetStalePublishing,
  updateActivity,
} from "@/lib/influencer/activities";
import { getChannelCredentialCipher } from "@/lib/influencer/credentials";
import { listChannels, listPersonas } from "@/lib/influencer/personas";
import {
  isReplyKind,
  type ActivityKind,
  type Persona,
  type PersonaActivity,
  type PersonaChannel,
} from "@/lib/influencer/types";

export type PublishDecision =
  | { action: "publish" }
  | { action: "defer"; until: string; reason: string }
  | { action: "reject"; reason: string }
  | { action: "skip"; reason: string };

export function dayStartUtcIso(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

export function nextDayStartUtcIso(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

/**
 * Handles belonging to the fleet (persona handles + linked platform handles).
 * A persona must never reply to, quote or mention another persona: a network
 * of automated accounts amplifying each other reads as coordinated platform
 * manipulation even when every account is labeled as AI.
 */
export function buildFleetHandles(
  personas: Persona[],
  channels: PersonaChannel[],
): Set<string> {
  const handles = new Set<string>();
  for (const persona of personas) {
    handles.add(persona.handle.toLowerCase());
  }
  for (const channel of channels) {
    if (channel.external_handle) {
      handles.add(channel.external_handle.toLowerCase().replace(/^@/, ""));
    }
  }
  return handles;
}

function mentionsFleetHandle(
  activity: PersonaActivity,
  ownHandles: Set<string>,
  fleetHandles: Set<string>,
): string | null {
  const target =
    typeof activity.content_meta.target_handle === "string"
      ? activity.content_meta.target_handle.toLowerCase().replace(/^@/, "")
      : null;
  if (target && fleetHandles.has(target) && !ownHandles.has(target)) {
    return target;
  }

  const mentions = activity.content.match(/@([a-z0-9_]{2,32})/gi) ?? [];
  for (const raw of mentions) {
    const handle = raw.slice(1).toLowerCase();
    if (fleetHandles.has(handle) && !ownHandles.has(handle)) {
      return handle;
    }
  }
  return null;
}

function violatedForbiddenTopic(
  activity: PersonaActivity,
  persona: Persona,
): string | null {
  const haystack = `${activity.title ?? ""} ${activity.content}`.toLowerCase();
  for (const topic of persona.forbidden_topics) {
    const needle = topic.trim().toLowerCase();
    if (needle && haystack.includes(needle)) return topic;
  }
  return null;
}

export function resolvePublishDecision({
  activity,
  persona,
  channel,
  fleetHandles,
  publishedToday,
  now,
}: {
  activity: PersonaActivity;
  persona: Persona | undefined;
  channel: PersonaChannel | undefined;
  fleetHandles: Set<string>;
  publishedToday: number;
  now: Date;
}): PublishDecision {
  if (!persona) return { action: "reject", reason: "Persona no longer exists." };
  if (!channel) return { action: "reject", reason: "Channel no longer exists." };

  if (persona.status !== "active") {
    return { action: "skip", reason: "Persona is paused." };
  }
  if (channel.status !== "active") {
    return { action: "skip", reason: `Channel is ${channel.status}.` };
  }
  if (channel.automation_level === "draft_only") {
    return {
      action: "reject",
      reason:
        "draft_only channel: the tool never publishes here — a human posts by hand.",
    };
  }

  const fleetMention = mentionsFleetHandle(
    activity,
    new Set(
      [persona.handle, channel.external_handle ?? ""]
        .filter(Boolean)
        .map((h) => h.toLowerCase().replace(/^@/, "")),
    ),
    fleetHandles,
  );
  if (fleetMention) {
    return {
      action: "reject",
      reason: `Fleet amplification blocked: targets @${fleetMention}, another persona of the fleet.`,
    };
  }

  const forbidden = violatedForbiddenTopic(activity, persona);
  if (forbidden) {
    return {
      action: "reject",
      reason: `Touches forbidden topic "${forbidden}".`,
    };
  }

  const cap = isReplyKind(activity.kind)
    ? channel.max_replies_per_day
    : channel.max_posts_per_day;
  if (publishedToday >= cap) {
    return {
      action: "defer",
      until: nextDayStartUtcIso(now),
      reason: `Daily cap reached (${cap}/day).`,
    };
  }

  return { action: "publish" };
}

// ---------------------------------------------------------------------------
// Channel adapters
// ---------------------------------------------------------------------------

type PublishOutcome = {
  external_id: string | null;
  external_url: string | null;
};

async function publishViaPostBridge(
  activity: PersonaActivity,
  channel: PersonaChannel,
): Promise<PublishOutcome> {
  const accountId = Number(channel.channel_config.post_bridge_account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error(
      "Channel has no post_bridge_account_id in channel_config. Link the persona's account in Post-Bridge and store its id.",
    );
  }

  const scheduled = await scheduleSocialPost({
    caption: activity.content,
    // Post-Bridge needs a future timestamp; two minutes out is "now".
    scheduledAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    socialAccountIds: [accountId],
  });

  return { external_id: scheduled.id, external_url: null };
}

/**
 * credentials_ref is data anyone with app access can edit; using it verbatim
 * as a process.env key would let a row read arbitrary secrets. Only
 * DEVTO_API_KEY or DEVTO_API_KEY_<SUFFIX> (one per persona account) resolve.
 */
export function isAllowedDevtoEnvName(name: string): boolean {
  return /^DEVTO_API_KEY(_[A-Z0-9_]+)?$/.test(name);
}

async function resolveDevtoApiKey(
  client: SupabaseClient,
  channel: PersonaChannel,
): Promise<string> {
  // Preferred: the key the persona connected in-app (encrypted vault).
  const cipher = await getChannelCredentialCipher(client, channel.persona_id, "devto");
  if (cipher) {
    const key = decryptPersonaKey(cipher).trim();
    if (key) return key;
  }
  // Back-compat: an allowlisted env var named by credentials_ref.
  const envName = channel.credentials_ref?.trim() || "DEVTO_API_KEY";
  if (!isAllowedDevtoEnvName(envName)) {
    throw new Error(
      `credentials_ref "${envName}" is not allowed. Use DEVTO_API_KEY or DEVTO_API_KEY_<HANDLE>.`,
    );
  }
  const apiKey = process.env[envName]?.trim();
  if (!apiKey) {
    throw new Error(
      `No dev.to credential for this persona. Connect a dev.to API key, or set ${envName} in the environment.`,
    );
  }
  return apiKey;
}

async function publishToDevto(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
): Promise<PublishOutcome> {
  const apiKey = await resolveDevtoApiKey(client, channel);

  const canonicalUrl =
    typeof activity.content_meta.canonical_url === "string"
      ? activity.content_meta.canonical_url
      : undefined;
  const tags = Array.isArray(activity.content_meta.tags)
    ? activity.content_meta.tags.filter((t): t is string => typeof t === "string")
    : undefined;

  const response = await fetch("https://dev.to/api/articles", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/vnd.forem.api-v1+json",
    },
    cache: "no-store",
    body: JSON.stringify({
      article: {
        title: activity.title || activity.content.slice(0, 80),
        body_markdown: activity.content,
        published: true,
        ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
        ...(tags?.length ? { tags: tags.slice(0, 4) } : {}),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`dev.to API ${response.status}: ${text.slice(0, 300)}`);
  }

  const body = (await response.json()) as { id?: number; url?: string };
  return {
    external_id: body.id ? String(body.id) : null,
    external_url: body.url ?? null,
  };
}

async function publishActivity(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
): Promise<PublishOutcome> {
  switch (channel.publish_via) {
    case "post_bridge":
      return publishViaPostBridge(activity, channel);
    case "api":
      if (channel.platform === "devto") return publishToDevto(client, activity, channel);
      throw new Error(`No API adapter for platform "${channel.platform}" yet.`);
    case "n8n":
      throw new Error(
        "Blog/microsite adapter is not wired yet (phase 2 — depends on the aicodereview.io stack).",
      );
    case "manual":
      throw new Error("Manual channels are never published by the tool.");
  }
}

// ---------------------------------------------------------------------------
// Cron entry point
// ---------------------------------------------------------------------------

export type PublishCronSummary = {
  examined: number;
  published: number;
  deferred: number;
  rejected: number;
  failed: number;
  skipped: number;
};

export async function runInfluencerPublishCron(
  options: { client?: SupabaseClient; now?: Date } = {},
): Promise<PublishCronSummary> {
  const client = options.client ?? getSupabaseServiceClient();
  const now = options.now ?? new Date();
  const summary: PublishCronSummary = {
    examined: 0,
    published: 0,
    deferred: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };

  // Recover claims orphaned by a crash between claim and outcome update.
  const staleCutoff = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const reset = await resetStalePublishing(client, staleCutoff);
  if (reset > 0) {
    console.warn(`[influencer] reset ${reset} stale publishing claim(s) to failed`);
  }

  const due = await listDueForPublish(client, now.toISOString());
  if (!due.length) return summary;

  const [personas, channels] = await Promise.all([
    listPersonas(client),
    listChannels(client),
  ]);
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const fleetHandles = buildFleetHandles(personas, channels);
  const dayStart = dayStartUtcIso(now);

  // Per-channel counts for this run: DB count + what we publish in this loop.
  const todayCount = new Map<string, number>();
  const countKey = (channelId: string, kind: ActivityKind) =>
    `${channelId}:${isReplyKind(kind) ? "reply" : "post"}`;

  for (const activity of due) {
    summary.examined += 1;
    const persona = personaById.get(activity.persona_id);
    const channel = channelById.get(activity.channel_id);

    const key = countKey(activity.channel_id, activity.kind);
    if (!todayCount.has(key)) {
      todayCount.set(
        key,
        await countPublishedToday(
          client,
          activity.channel_id,
          isReplyKind(activity.kind) ? ["reply", "quote"] : ["post", "article", "crosspost"],
          dayStart,
        ),
      );
    }

    const decision = resolvePublishDecision({
      activity,
      persona,
      channel,
      fleetHandles,
      publishedToday: todayCount.get(key) ?? 0,
      now,
    });

    if (decision.action === "skip") {
      summary.skipped += 1;
      continue;
    }

    if (decision.action === "reject") {
      await updateActivity(client, activity.id, {
        status: "failed",
        error: decision.reason,
      });
      summary.rejected += 1;
      continue;
    }

    if (decision.action === "defer") {
      await updateActivity(client, activity.id, {
        status: "scheduled",
        scheduled_at: decision.until,
        error: null,
      });
      summary.deferred += 1;
      continue;
    }

    const claimed = await claimActivityForPublishing(
      client,
      activity.id,
      activity.status,
    );
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }

    try {
      const outcome = await publishActivity(client, claimed, channel!);
      await updateActivity(client, activity.id, {
        status: "published",
        published_at: now.toISOString(),
        external_id: outcome.external_id,
        external_url: outcome.external_url,
        error: null,
      });
      todayCount.set(key, (todayCount.get(key) ?? 0) + 1);
      summary.published += 1;
    } catch (error) {
      await updateActivity(client, activity.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      summary.failed += 1;
    }
  }

  return summary;
}
