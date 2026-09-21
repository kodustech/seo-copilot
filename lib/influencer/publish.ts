/**
 * persona-publish: the persona's "body". The brain (generation/agent) only
 * writes drafts; every hard wall lives here, outside the model — channel
 * automation level, daily caps, forbidden topics, and the fleet-amplification
 * block. Worst case upstream is a bad draft in the queue, never a bad post
 * on the wire.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { scheduleSocialPost } from "@/lib/copilot";
import { isOwnedDomain } from "@/lib/owned-domains";
import { parseImageIntent, resolvePostImage } from "@/lib/influencer/post-image";
import { postReplyOnX } from "@/lib/influencer/browser";
import {
  importStoryOnMedium,
  mediumContextId,
  mediumSourceUrl,
  requiresDisclosure,
  sourceDiscloses,
} from "@/lib/influencer/medium";
import { blogSchemaFor, resolveBlogCategory } from "@/lib/influencer/blog-schema";
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
import { renderVideoClips, YoutubeDeferred } from "@/lib/influencer/video-pipeline";
import {
  buildVideoDescription,
  youtubeChannelConfig,
  youtubeChannelReady,
} from "@/lib/influencer/youtube";
import { getYoutubeAccessToken, uploadYoutubeVideo } from "@/lib/influencer/youtube-upload";
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
  | { action: "discard"; reason: string }
  | { action: "skip"; reason: string };

/** News-reactive X content past this age isn't worth posting — a 2-day-old
 *  "hot take" is stale. Evergreen articles (blog/devto) never expire. */
const STALE_X_HOURS = 36;

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
  if (activity.content_meta.test_run === true) {
    return { action: "reject", reason: "Test drafts can never be published." };
  }
  if (!persona) return { action: "reject", reason: "Persona no longer exists." };
  if (!channel) return { action: "reject", reason: "Channel no longer exists." };

  if (persona.status !== "active") {
    return { action: "skip", reason: "Persona is paused." };
  }
  if (channel.status !== "active") {
    return { action: "skip", reason: `Channel is ${channel.status}.` };
  }
  // A hand-posted channel is published by a person, who then marks it
  // published with the link. The tool never puts it on the wire, and it must
  // not fail it either: a draft waiting for a person is not broken. The cron
  // leaves these channels out of its due list; this is the wall for anything
  // that reaches it anyway.
  if (channel.publish_via === "manual") {
    return {
      action: "skip",
      reason: "Hand-posted channel: a person posts it and marks it published.",
    };
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

  // A reply's TARGET is a fleet-amplification vector too: replying to another
  // persona's tweet is the same coordinated boost, even with no @mention in text.
  if (isReplyKind(activity.kind)) {
    const replyTo =
      typeof activity.content_meta?.reply_to === "string" ? activity.content_meta.reply_to : "";
    const target = replyTo.match(/x\.com\/([^/?#]+)\/status\//i)?.[1]?.toLowerCase().replace(/^@/, "");
    if (target && fleetHandles.has(target)) {
      return {
        action: "reject",
        reason: `Fleet amplification blocked: replying to @${target}, another persona of the fleet.`,
      };
    }
  }

  const forbidden = violatedForbiddenTopic(activity, persona);
  if (forbidden) {
    return {
      action: "reject",
      reason: `Touches forbidden topic "${forbidden}".`,
    };
  }

  // YouTube without a finished file is not a failure — it is a pipeline
  // waiting on a person (composite script, then Studio checkbox). Defer with
  // the next action instead of claiming it every run.
  if (channel.platform === "youtube") {
    const meta = activity.content_meta;
    const finalUrl = typeof meta.final_url === "string" ? meta.final_url.trim() : "";
    // A finished clip set waits on the composite (worker or person). Anything
    // else resumes rendering — partial clip sets included.
    if (!finalUrl && meta.stage === "clips_ready") {
      return {
        action: "defer",
        until: nextDayStartUtcIso(now),
        reason: "Composite pending: the worker (or scripts/render-video-from-plan.py) attaches final_url.",
      };
    }
  }

  // Freshness: an X take that has sat past its due time for too long is stale
  // news — discard it rather than defer it again (deferring only makes it
  // staler). Measure from scheduled_at when set (a deliberately future-scheduled
  // post is only stale once it has sat past ITS date), else from created_at.
  if (channel.platform === "x") {
    const dueAt = activity.scheduled_at ?? activity.created_at;
    const ageMs = now.getTime() - new Date(dueAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > STALE_X_HOURS * 60 * 60 * 1000) {
      return {
        action: "discard",
        reason: `Stale: past its post time by ~${Math.round(ageMs / 3_600_000)}h, the news has moved on.`,
      };
    }
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
  // Quote-tweets need a different flow than a plain reply; not built yet, so fail
  // loudly rather than silently posting a bare reply.
  if (activity.kind === "quote") {
    throw new Error("Quote-tweets aren't supported yet — use a reply or a standalone post.");
  }
  // A reply isn't a standalone post — Post-Bridge can't reply to a specific tweet,
  // so drive the logged-in browser to post it under the target. This is the
  // follower-growth path: showing up under bigger accounts' conversations.
  if (activity.kind === "reply") {
    const replyTo =
      typeof activity.content_meta?.reply_to === "string"
        ? activity.content_meta.reply_to.trim()
        : "";
    if (!replyTo) {
      throw new Error("Reply draft has no reply_to target tweet.");
    }
    const r = await postReplyOnX(replyTo, activity.content);
    if (!r.posted) {
      throw new Error("Reply did not post (composer or submit failed).");
    }
    // external_url would be the persona's reply URL, which the browser can't
    // reliably capture — leave it null rather than point at the target tweet.
    return { external_id: null, external_url: null };
  }

  const accountId = Number(channel.channel_config.post_bridge_account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error(
      "Channel has no post_bridge_account_id in channel_config. Link the persona's account in Post-Bridge and store its id.",
    );
  }

  // Attach an image if the draft asked for one (screenshot of a real page, or a
  // public image URL). Best-effort: a failed image never blocks the text post.
  const intent = parseImageIntent(activity.content_meta);
  const media = intent ? await resolvePostImage(intent) : null;

  const scheduled = await scheduleSocialPost({
    caption: activity.content,
    // Post-Bridge needs a future timestamp; two minutes out is "now".
    scheduledAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    socialAccountIds: [accountId],
    mediaIds: media?.mediaIds,
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
  // If a previous attempt already recorded the remote id, a retry must never
  // POST another article. This also makes the adapter safe for callers that
  // re-run a claimed activity after a transient failure.
  if (activity.external_id) {
    return { external_id: activity.external_id, external_url: activity.external_url };
  }
  const apiKey = await resolveDevtoApiKey(client, channel);

  const canonicalUrl =
    typeof activity.content_meta.canonical_url === "string"
      ? activity.content_meta.canonical_url
      : undefined;
  const tags = sanitizeTags(activity.content_meta.tags);

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

// `||` (not `??`) so an empty AICODEREVIEW_API_URL falls back instead of
// producing a broken relative URL.
export const DEFAULT_BLOG_API_URL = (
  process.env.AICODEREVIEW_API_URL?.trim() || "https://aicodereview.io"
).replace(/\/$/, "");

/**
 * Which site this blog channel publishes to. A network of blogs is the point —
 * one env var could only ever address one of them — so the destination lives on
 * the channel and the env var is just the default.
 *
 * It must be https, because the article travels with a bearer token. It does NOT
 * have to be on a domain we hardcode: a farm site is connected in the app, and
 * requiring a deploy to add one was the thing that made the farm expensive.
 *
 * What protects the token instead is that it is per site. A channel connected
 * with its own key can only ever leak that key, to the host whoever connected
 * it typed. The SHARED key is the one worth guarding, and contentEnvNameFor
 * still refuses to hand it to anything but the default site.
 */
export function resolveBlogApiUrl(channel: PersonaChannel): string {
  const configured =
    typeof channel.channel_config.blog_api_url === "string"
      ? channel.channel_config.blog_api_url.trim()
      : "";
  const raw = (configured || DEFAULT_BLOG_API_URL).replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`blog_api_url "${raw}" is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`blog_api_url must be https (got "${raw}") — it carries the API key.`);
  }
  return raw;
}

/**
 * Where a blog channel's markdown can be read back from, so a persona can
 * revise a page instead of only ever adding one. The published page is no use
 * for that: it is rendered HTML, and round-tripping it through the model would
 * lose the frontmatter and mangle the body.
 *
 * Configured per channel because the path convention belongs to the site's
 * repo. No credential travels with this read — the farm repos are public — so
 * it is guarded as a public URL rather than against the owned-domain list.
 */
export function resolveBlogSourceBase(channel: PersonaChannel): string | null {
  const raw = channel.channel_config.blog_source_base;
  const base = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return base || null;
}

export function isAllowedContentEnvName(name: string): boolean {
  return /^CONTENT_API_KEY(_[A-Z0-9_]+)?$/.test(name);
}

/** What the connect flow writes for a channel on the default site. It names no
 *  env var of its own — it means "the shared key". */
export const CONTENT_KEY_SENTINEL = "env:content_api";

/** What it writes for a site whose own key went into the vault. Also not an env
 *  var name: the key is read from persona_credentials, not the environment. */
export const CONTENT_KEY_VAULT = "vault:blog";

/** Scheme, host and port — everything that decides which service receives the
 *  request. A path doesn't; `www.` and a trailing dot are the same host. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return `${u.protocol.toLowerCase()}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * Whether this channel publishes to the default site rather than a farm one.
 *
 * Asked through resolveBlogApiUrl on purpose. Every attempt to answer it
 * separately has drifted from the resolver in a way that either leaked the
 * shared key or silenced a channel entitled to it: comparing whole strings
 * denied a base URL with a path, comparing hostnames granted a different scheme
 * and a different port. Routing the question through the resolver means the two
 * cannot disagree, because there is only one answer — https, a domain we own,
 * and then the same origin as the default.
 */
function isDefaultSite(channel: PersonaChannel): boolean {
  let resolved: string;
  try {
    resolved = resolveBlogApiUrl(channel);
  } catch {
    return false;
  }
  return isDefaultBlogSite(resolved);
}

/** Whether a base URL points at the default site — the only one the shared key
 *  is ever sent to. Exported so the connect form can refuse a farm host with no
 *  key of its own, instead of reporting success on a channel that can never
 *  publish. */
export function isDefaultBlogSite(url: string): boolean {
  return sameBlogSite(url, DEFAULT_BLOG_API_URL);
}

/**
 * The site a blog channel will publish to after this connect: what the request
 * carries, else what the channel already stored, else the default. Every check
 * around connecting has to judge THIS, not the request — a blank api_url keeps
 * the stored URL, and judging the request alone has now produced the same bug
 * three times, in both directions.
 */
export function blogDestination(
  channel: Pick<PersonaChannel, "channel_config">,
  requestedApiUrl: string,
): string {
  const stored =
    typeof channel.channel_config.blog_api_url === "string"
      ? channel.channel_config.blog_api_url.trim()
      : "";
  return requestedApiUrl.trim() || stored || DEFAULT_BLOG_API_URL;
}

/**
 * The sibling channel whose stored blog key this connect would overwrite, if
 * any. The vault holds one row per persona per provider, so a second farm site
 * on the same persona silently takes the first one's key and both then publish
 * with whichever was written last.
 */
export function findBlogKeyClash(
  siblings: PersonaChannel[],
  opts: { channelId: string; destination: string },
): PersonaChannel | undefined {
  return siblings.find(
    (c) =>
      c.id !== opts.channelId &&
      c.platform === "blog" &&
      c.credentials_ref?.trim() === CONTENT_KEY_VAULT &&
      !sameBlogSite(String(c.channel_config.blog_api_url ?? ""), opts.destination),
  );
}

/**
 * Whether two base URLs name the same site. Blank means the default, since that
 * is what the publisher resolves, and the comparison is by origin — a trailing
 * slash, a `www.` or a different case is the same host, and comparing the raw
 * strings would refuse connects the publisher would have accepted.
 */
export function sameBlogSite(a: string, b: string): boolean {
  const left = originOf(a.trim() || DEFAULT_BLOG_API_URL);
  const right = originOf(b.trim() || DEFAULT_BLOG_API_URL);
  return left !== null && left === right;
}

/**
 * Whether a connect request must carry a key, or may rely on the one the
 * channel already keeps. This endpoint is also how an operator edits a
 * connected channel's taxonomy, and asking for the key back to change a word
 * would teach people to disconnect first — which drops the key for real.
 *
 * Two conditions, and the second is the load-bearing one. The channel must
 * hold a key of its OWN: the vault marker, or a per-site env name, never the
 * sentinel, which is the shared key and belongs to the default site. And the
 * destination must not be moving, because resolveBlogApiKey finds that key by
 * the marker rather than by host — so a request that repointed the channel and
 * skipped this check would send one site's writer credential to whatever host
 * it named. Changing site costs a key, exactly as it always did.
 */
export function blogConnectNeedsKey(
  channel: Pick<PersonaChannel, "credentials_ref" | "channel_config">,
  destination: string,
): boolean {
  const ref = channel.credentials_ref?.trim() ?? "";
  // Its own key: the vault marker, or a per-site env name. Never one that means
  // the shared key — that one belongs to the default site, and contentEnvNameFor
  // hands it to nothing else. Both read refMeansSharedKey so they cannot drift.
  const holdsOwnKey =
    ref === CONTENT_KEY_VAULT || (!refMeansSharedKey(ref) && isAllowedContentEnvName(ref));
  if (!holdsOwnKey) return true;
  const stored =
    typeof channel.channel_config.blog_api_url === "string"
      ? channel.channel_config.blog_api_url
      : "";
  return !sameBlogSite(destination, stored);
}

/**
 * Which env var holds this blog channel's key, or null when we have no key we
 * are willing to send it. Both the publisher and the shift's actionability
 * check go through here: a gate that answers differently from the resolver
 * either spends shifts writing for a site that can't publish, or silences a
 * site that can.
 *
 * The shared key belongs to the default site, so it is only offered to a
 * channel that publishes there. A farm site inherits nothing — it names its own
 * CONTENT_API_KEY_<SITE> or it gets no key, because the alternative is sending
 * one site's writer credential to another host and finding out from the 401.
 */
/**
 * Whether a credentials_ref means the SHARED key rather than one of the
 * channel's own. Naming the shared key outright is the same request as the
 * sentinel, and so is naming nothing. Asked in one place because the gate and
 * the resolver disagreeing about this ref is precisely how a channel gets
 * reported connected and then publishes nowhere.
 */
export function refMeansSharedKey(ref: string | null | undefined): boolean {
  const clean = ref?.trim();
  return !clean || clean === CONTENT_KEY_SENTINEL || clean === "CONTENT_API_KEY";
}

export function contentEnvNameFor(channel: PersonaChannel): string | null {
  const ref = channel.credentials_ref?.trim();
  if (refMeansSharedKey(ref)) {
    return isDefaultSite(channel) ? "CONTENT_API_KEY" : null;
  }
  return isAllowedContentEnvName(ref!) ? ref! : null;
}

/**
 * The key a blog channel publishes with. The vault comes first when the channel
 * says its key lives there: connecting a farm site in the app is the point, and
 * an env var per site means a deploy per site. The env path stays for sites
 * configured before the vault learned this provider.
 *
 * The marker is load-bearing, not decoration. Reading the vault unconditionally
 * would hand a persona's stored key to ANY of its blog channels — including one
 * pointed at a different site, and including after a disconnect, since the row
 * outlives the channel it was connected for. That would send one site's writer
 * credential to another host, which is the exact thing the per-site key exists
 * to prevent.
 *
 * Note the vault holds one key per persona per provider. A persona with two
 * blog channels shares it; a farm keeps one persona per site, which is also how
 * the voice stays separate.
 */
async function resolveBlogApiKey(
  client: SupabaseClient,
  channel: PersonaChannel,
): Promise<string> {
  if (channel.credentials_ref?.trim() === CONTENT_KEY_VAULT) {
    const cipher = await getChannelCredentialCipher(client, channel.persona_id, "blog");
    if (cipher) {
      const key = decryptPersonaKey(cipher).trim();
      if (key) return key;
    }
  }
  return resolveBlogApiKeyFromEnv(channel);
}

function resolveBlogApiKeyFromEnv(channel: PersonaChannel): string {
  const envName = contentEnvNameFor(channel);
  if (!envName) {
    throw new Error(
      `No key for this blog. A channel publishing to ${resolveBlogApiUrl(channel)} needs its own ` +
        `credentials_ref naming CONTENT_API_KEY_<SITE> — the shared CONTENT_API_KEY belongs to ` +
        `${DEFAULT_BLOG_API_URL} and is not sent anywhere else.`,
    );
  }
  const key = process.env[envName]?.trim();
  if (!key) {
    throw new Error(
      `No content API credential for this blog. Connect one, or set ${envName} in the environment.`,
    );
  }
  return key;
}

/**
 * The body of a content-API call, built from a draft and the site it is going
 * to. Exported because the payload's shape is the whole contract with a farm
 * site, and the one thing worth testing against that site's own validator —
 * 33 posts died on a field this function forgot, and none of it was visible
 * from inside publishToBlog.
 */
export function buildBlogPayload(
  activity: PersonaActivity,
  channel: PersonaChannel,
): Record<string, unknown> {
  const meta = activity.content_meta ?? {};
  const asString = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const tags = sanitizeTags(meta.tags);
  const faq = Array.isArray(meta.faq)
    ? meta.faq.filter(
        (f): f is { q: string; a: string } =>
          Boolean(f) &&
          typeof (f as { q?: unknown }).q === "string" &&
          typeof (f as { a?: unknown }).a === "string",
      )
    : undefined;

  // What THIS site accepts — the farm's sites do not share a taxonomy.
  const schema = blogSchemaFor(channel);
  // A site with a second axis requires it: mergerequests.dev files every post
  // under a forge, and a post that names none has nowhere to appear. Refused
  // here, in our own words, rather than shipped to collect the site's 422 —
  // the draft is fixable, and "must be one of …" is the only useful half of it.
  const blogPlatform = asString(meta.blog_platform)?.toLowerCase();
  if (schema.platforms && !(blogPlatform && schema.platforms.includes(blogPlatform))) {
    throw new Error(
      `${resolveBlogApiUrl(channel)} files every post under a platform, and this draft names ${
        blogPlatform ? `"${blogPlatform}"` : "none"
      }. Requeue it with blog_platform set to one of: ${schema.platforms.join(", ")}.`,
    );
  }
  // A revision is the same call with the slug it replaces: the content API
  // refuses an existing slug unless overwrite says so, and the site is
  // git-backed, so a rewrite lands as a commit over the old file rather than
  // as a second page competing with the first.
  const replaces = asString(meta.replaces_slug);
  return {
    title: activity.title || activity.content.slice(0, 80),
    description: asString(meta.description),
    category: resolveBlogCategory(schema, asString(meta.category)),
    tags: tags?.length ? tags : undefined,
    content: activity.content, // markdown, no H1 (layout renders the title)
    faq: faq?.length ? faq : undefined,
    // Only where the site declares the axis. A site without one has no such
    // frontmatter field, so sending it is at best ignored and at worst a 422
    // from a stricter validator than the two we have.
    ...(schema.platforms && blogPlatform ? { platform: blogPlatform } : {}),
    ...(replaces
      ? {
          slug: replaces,
          overwrite: true,
          // The content API uses this to render "Last updated" and to produce
          // dateModified in the article schema. It is deliberately generated
          // at publish time so a delayed draft does not claim a stale revision
          // date, and the agent cannot forget it.
          updated_at: new Date().toISOString(),
        }
      : {}),
  };
}

async function publishToBlog(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
): Promise<PublishOutcome> {
  const blogApiUrl = resolveBlogApiUrl(channel);
  const key = await resolveBlogApiKey(client, channel);
  const payload = buildBlogPayload(activity, channel);

  const response = await fetch(`${blogApiUrl}/api/posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${blogApiUrl} API ${response.status}: ${text.slice(0, 300)}`);
  }

  const body = (await response.json().catch(() => ({}))) as {
    id?: string | number;
    url?: string;
    slug?: string;
  };
  return {
    external_id: body.id != null ? String(body.id) : null,
    external_url: body.url ?? (body.slug ? `${blogApiUrl}/${body.slug}` : null),
  };
}

/**
 * Medium has no API to call. It is published by driving the persona's
 * logged-in browser through Medium's own "Import a story" page, which copies
 * a page of ours into a story with the canonical set back to it. So a Medium
 * activity is always a crosspost of a page we already published; the content
 * field is never typed into Medium.
 *
 * The disclosure check runs before a browser is opened: Medium shows
 * undisclosed AI writing to followers only, and an import nobody sees is a
 * session spent for nothing.
 */
async function publishToMedium(
  activity: PersonaActivity,
  channel: PersonaChannel,
  persona: Persona,
): Promise<PublishOutcome> {
  const contextId = mediumContextId(channel);
  if (!contextId) {
    throw new Error(
      "Medium is not connected: this channel has no logged-in browser context. Connect it from the channel card.",
    );
  }
  const { url, reason } = mediumSourceUrl(activity);
  if (!url) throw new Error(reason ?? "Nothing to import.");
  if (requiresDisclosure(channel)) {
    const check = await sourceDiscloses(url, persona.disclosure);
    if (!check.ok) throw new Error(check.reason ?? "Source page has no AI disclosure.");
  }
  const result = await importStoryOnMedium(url, {
    contextId,
    proxies: channel.channel_config.proxies === true,
  });
  if (result.stage === "signin") {
    throw new Error(
      "Medium session expired — reconnect the channel and sign in again through the live browser.",
    );
  }
  if (!result.imported) {
    throw new Error(
      `Medium import did not reach the editor (stopped at: ${result.stage}${
        result.url ? `, landed on ${result.url}` : ""
      }). Medium may have changed its import page.`,
    );
  }
  if (!result.published) {
    throw new Error(
      `Imported into Medium but the publish step did not complete (stopped at: ${result.stage}). The story may sit as a draft in the Medium account — check there before re-approving, or a second import would duplicate it.`,
    );
  }
  return { external_id: null, external_url: result.url };
}

/** The channels a person publishes. The cron leaves their activities alone:
 *  an approved draft there is waiting for a person, not for the publisher. */
export function manualChannelIds(channels: PersonaChannel[]): string[] {
  return channels.filter((c) => c.publish_via === "manual").map((c) => c.id);
}

/**
 * YouTube in three passes across cron runs: (1) approved script with no
 * clips → render HeyGen clips (money gate inside), then stop; (2) clips but
 * no finished file → stop, a person runs the composite script; (3) finished
 * file attached → upload unlisted. The person publishes from Studio after
 * the AI-content checkbox. Nothing here can put a video public alone.
 */
async function publishToYoutube(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
): Promise<PublishOutcome> {
  const meta = activity.content_meta;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const finalUrl = text(meta.final_url);
  // The cron claimed this row (status = publishing) before calling here. Both
  // exits below stop on purpose, so release the claim back to scheduled first
  // — otherwise the row sits in publishing until the stale reset fails it and
  // the pipeline's next passes never run.
  const parkForComposite = () =>
    updateActivity(client, activity.id, {
      status: "scheduled",
      scheduled_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      error: null,
    });
  if (!finalUrl) {
    // Resume whenever the script is not fully rendered — with the 45s poll
    // budget, parking mid-render is the normal outcome, not the exception.
    // Only a finished clip set (stage = clips_ready) waits on the composite.
    if (meta.stage !== "clips_ready") {
      await renderVideoClips(client, activity, channel, new Date());
      await parkForComposite();
      throw new YoutubeDeferred("Avatar clips incomplete — parked progress and resuming next run.");
    }
    await parkForComposite();
    throw new YoutubeDeferred("Composite pending: run the worker (or scripts/render-video-from-plan.py) and attach final_url to this activity.");
  }
  const cfg = youtubeChannelConfig(channel);
  const missing = youtubeChannelReady(cfg);
  if (missing) throw new Error(missing);
  const cipher = await getChannelCredentialCipher(client, channel.persona_id, "youtube");
  if (!cipher) throw new Error("YouTube channel is not connected (no OAuth token in the vault).");
  const accessToken = await getYoutubeAccessToken(decryptPersonaKey(cipher).trim());
  const res = await fetch(finalUrl, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Finished video unreachable (HTTP ${res.status}): ${finalUrl.slice(0, 120)}`);
  // Check the declared size before buffering: the guard must reject before
  // the cron process allocates the file, not after.
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > 256 * 1024 * 1024) {
    throw new Error("Finished video over 256MB — the server will not ferry it. Upload from Studio instead.");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > 256 * 1024 * 1024) {
    throw new Error("Finished video over 256MB — the server will not ferry it. Upload from Studio instead.");
  }
  const description = buildVideoDescription({
    canonicalUrl: text(meta.canonical_url) || null,
    musicCredit: text(meta.music_credit) || null,
    siteUrl: cfg.siteUrl,
  });
  const { videoId, watchUrl } = await uploadYoutubeVideo({
    accessToken,
    title: activity.title?.trim() || activity.content.slice(0, 80),
    description,
    videoBytes: bytes,
  });
  await updateActivity(client, activity.id, {
    content_meta: { ...meta, stage: "uploaded_unlisted" },
  });
  return { external_id: videoId, external_url: watchUrl };
}

/** dev.to (and most tag systems) reject non-alphanumeric tags like "ai-agents".
 *  Normalize to lowercase alphanumeric, drop empties/dupes, cap the count. */
function sanitizeTags(
  raw: unknown,
  max = 4,
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = Array.from(
    new Set(
      raw
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
        .filter(Boolean),
    ),
  ).slice(0, max);
  return cleaned.length ? cleaned : undefined;
}

async function publishActivity(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
  persona: Persona,
): Promise<PublishOutcome> {
  // A blog publishes via its own content API regardless of the channel's stored
  // publish_via; which site that is comes from the channel.
  if (channel.platform === "blog") return publishToBlog(client, activity, channel);
  // Medium likewise: there is exactly one way to publish there, and it is the
  // browser. The stored publish_via says "browser" once connected, but a
  // channel created before that existed still says "manual".
  if (channel.platform === "medium") return publishToMedium(activity, channel, persona);
  if (channel.platform === "youtube") return publishToYoutube(client, activity, channel);

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
    case "browser":
      throw new Error(`No browser adapter for platform "${channel.platform}" yet.`);
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

  const [personas, channels] = await Promise.all([
    listPersonas(client),
    listChannels(client),
  ]);
  // Hand-posted channels never come through here: their approved drafts wait
  // for a person, and pulling them into a 50-row due list every run would
  // crowd out the ones the publisher can actually send.
  const due = await listDueForPublish(
    client,
    now.toISOString(),
    50,
    manualChannelIds(channels),
  );
  if (!due.length) return summary;

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
          isReplyKind(activity.kind) ? ["reply", "quote"] : ["post", "article", "crosspost", "video"],
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

    if (decision.action === "discard") {
      await updateActivity(client, activity.id, {
        status: "discarded",
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
      const outcome = await publishActivity(client, claimed, channel!, persona!);
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
      // A stage that stopped on purpose (parked HeyGen render, composite
      // waiting on a person) is progress, not failure.
      if (error instanceof YoutubeDeferred) {
        summary.deferred += 1;
        continue;
      }
      await updateActivity(client, activity.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      summary.failed += 1;
    }
  }

  return summary;
}
