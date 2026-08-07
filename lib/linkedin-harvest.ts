/**
 * LinkedIn comment harvesting.
 *
 * A prospect list built from company fit tells you who might care. A person
 * who publicly commented on a post about AI code review last Tuesday tells
 * you who *did* care, when, and in their own words. This module turns a topic
 * into that second thing.
 *
 * The chain:
 *   1. Exa finds LinkedIn posts on the topic       (collectLinkedIn — no auth)
 *   2. The activity id comes out of the post URL   (pure string work)
 *   3. Unipile resolves the post's social_id       (1 call per post)
 *   4. Unipile lists the commenters                (1+ calls per post)
 *
 * Steps 3 and 4 run against the real connected LinkedIn account, so they are
 * paced and capped in lib/unipile.ts. Step 1 and 2 are free — which is why
 * discovery is exposed as its own tool.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { collectLinkedIn } from "@/lib/social-monitoring";
import {
  defaultLinkedInAccountId,
  extractLinkedInActivityId,
  getUnipilePost,
  isUnipileConfigured,
  listUnipilePostComments,
  normalizeLinkedInIdentity,
  unipileHarvestBudget,
  UnipileHttpError,
  type UnipilePostComment,
} from "@/lib/unipile";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type DiscoveredPost = {
  url: string;
  /** null when the URL carries no activity id — the post is not harvestable. */
  activityId: string | null;
  author: string | null;
  title: string;
  publishedDate: string | null;
};

export async function findLinkedInPosts(opts: {
  queries?: string[];
  daysBack?: number;
  maxResults?: number;
}): Promise<DiscoveredPost[]> {
  // collectLinkedIn is the shared monitoring sweep and swallows per-query
  // errors by design, so a missing key would come back as "no posts found"
  // — indistinguishable from a topic nobody is posting about. Check up front
  // so a broken search reads as broken.
  if (!process.env.EXA_API_KEY?.trim()) {
    throw new Error(
      "EXA_API_KEY is not configured. Add the environment variable to search LinkedIn posts.",
    );
  }
  const maxResults = Math.max(1, Math.min(100, opts.maxResults ?? 25));
  const raw = await collectLinkedIn({
    queries: opts.queries,
    daysBack: opts.daysBack,
    // Ask Exa for more than we need: /pulse articles and activity-less URLs
    // get filtered out below, so the yield is always under the request.
    numResults: Math.max(10, Math.min(50, maxResults)),
  });

  const seen = new Set<string>();
  const out: DiscoveredPost[] = [];
  for (const r of raw) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({
      url: r.url,
      activityId: extractLinkedInActivityId(r.url),
      author: r.author,
      title: r.title,
      publishedDate: r.publishedDate,
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commenters
// ---------------------------------------------------------------------------

export type Commenter = {
  name: string | null;
  profileUrl: string | null;
  headline: string | null;
  /** DISTANCE_1 routes to a direct message; 2/3 to the cold queue. */
  networkDistance: string | null;
  commentText: string | null;
  commentedAt: string | null;
  postUrl: string;
  /** Kept for the write path and for sends; not part of the tool output. */
  commentId: string;
  activityId: string | null;
  postSocialId: string | null;
  providerId: string | null;
  publicIdentifier: string | null;
  profilePictureUrl: string | null;
  isReply: boolean;
  reactionCount: number | null;
  replyCount: number | null;
};

/**
 * Canonical https://www.linkedin.com/in/<slug>, the dedupe key.
 *
 * Member ids (ACoAA…) keep their case: LinkedIn resolves /in/ACoAA… but not
 * the lowercased form, so downcasing one would produce a dead link. They are
 * the fallback when a comment carries no vanity slug — a person we can still
 * identify and message beats a person we drop.
 */
export function canonicalProfileUrl(
  urlOrSlug: string | null | undefined,
): string | null {
  const raw = urlOrSlug?.trim();
  if (!raw) return null;
  if (/^ACoAA/i.test(raw)) return `https://www.linkedin.com/in/${raw}`;
  const fromUrl = raw.match(/linkedin\.com\/(?:in|pub)\/(ACoAA[^/?#]*)/i);
  if (fromUrl) return `https://www.linkedin.com/in/${fromUrl[1]}`;
  const slug = normalizeLinkedInIdentity(raw);
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

function toCommenter(
  c: UnipilePostComment,
  ctx: { postUrl: string; activityId: string | null; postSocialId: string | null },
): Commenter {
  return {
    name: c.name,
    profileUrl: canonicalProfileUrl(
      c.profileUrl ?? c.publicIdentifier ?? c.providerId,
    ),
    headline: c.headline,
    networkDistance: c.networkDistance,
    commentText: c.text,
    commentedAt: c.commentedAt,
    postUrl: ctx.postUrl,
    commentId: c.id,
    activityId: ctx.activityId,
    postSocialId: ctx.postSocialId,
    providerId: c.providerId,
    publicIdentifier: c.publicIdentifier,
    profilePictureUrl: c.profilePictureUrl,
    isReply: c.isReply,
    reactionCount: c.reactionCount,
    replyCount: c.replyCount,
  };
}

export type PostCommentersResult = {
  postUrl: string;
  activityId: string;
  socialId: string | null;
  postAuthor: string | null;
  commenters: Commenter[];
};

/**
 * Everyone who commented on one post.
 *
 * `postUrlOrActivityId` takes either form. A URL with no activity id in it is
 * an error rather than a guess — see extractLinkedInActivityId.
 */
export async function listPostCommenters(opts: {
  postUrlOrActivityId: string;
  accountId?: string | null;
  includeReplies?: boolean;
  maxComments?: number;
}): Promise<PostCommentersResult> {
  // Validate the input before complaining about configuration: extraction is
  // free and pure, so a caller who passed a profile URL should be told that,
  // not sent to check their API keys.
  const activityId = extractLinkedInActivityId(opts.postUrlOrActivityId);
  if (!activityId) {
    throw new Error(
      `No LinkedIn activity id in "${opts.postUrlOrActivityId}". Expected a /posts/…-activity-<id>-… URL, a urn:li:activity:<id>, or the bare id.`,
    );
  }
  if (!isUnipileConfigured()) {
    throw new Error("Unipile is not configured (UNIPILE_API_KEY / UNIPILE_DSN)");
  }

  const accountId = opts.accountId?.trim() || (await defaultLinkedInAccountId());
  if (!accountId) {
    throw new Error(
      "No connected LinkedIn account in Unipile. Connect one in Settings first.",
    );
  }

  const post = await getUnipilePost({ activityId, accountId });
  if (!post.socialId) {
    throw new Error(
      `Unipile returned no social_id for activity ${activityId}; the comments endpoint needs it.`,
    );
  }

  const comments = await listUnipilePostComments({
    socialId: post.socialId,
    accountId,
    includeReplies: opts.includeReplies,
    maxComments: opts.maxComments,
  });

  const postUrl = opts.postUrlOrActivityId.startsWith("http")
    ? opts.postUrlOrActivityId
    : `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;

  return {
    postUrl,
    activityId,
    socialId: post.socialId,
    postAuthor: post.authorName,
    commenters: comments.map((c) =>
      toCommenter(c, { postUrl, activityId, postSocialId: post.socialId }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type HarvestWriteResult = {
  peopleUpserted: number;
  peopleNew: number;
  triggersAdded: number;
};

/**
 * A storable timestamp, or null.
 *
 * LinkedIn sometimes hands back a relative date ("2mo") where an ISO string
 * was expected. Storing null loses the trigger date for that one comment;
 * passing the string through would fail the whole batch insert.
 */
function toIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Persist commenters into a research table's commenter list.
 *
 * Deduped on profile_url: the same person commenting on three posts is one
 * commenter row with three trigger rows. A commenter with no resolvable
 * profile URL is dropped — without it there is no identity to dedupe on and
 * no way to message them, so the row would be a name and nothing else.
 */
export async function saveCommenters(
  client: SupabaseClient,
  researchTableId: string,
  commenters: Commenter[],
): Promise<HarvestWriteResult> {
  let peopleUpserted = 0;
  let peopleNew = 0;
  let triggersAdded = 0;

  // Collapse to one record per profile before touching the database, keeping
  // the richest identity fields and every distinct comment.
  const byProfile = new Map<string, { person: Commenter; triggers: Commenter[] }>();
  for (const c of commenters) {
    if (!c.profileUrl || !c.name) continue;
    const entry = byProfile.get(c.profileUrl);
    if (!entry) {
      byProfile.set(c.profileUrl, { person: c, triggers: [c] });
      continue;
    }
    entry.triggers.push(c);
    // Prefer the sighting that actually carries the field.
    entry.person = {
      ...entry.person,
      headline: entry.person.headline ?? c.headline,
      networkDistance: entry.person.networkDistance ?? c.networkDistance,
      providerId: entry.person.providerId ?? c.providerId,
      publicIdentifier: entry.person.publicIdentifier ?? c.publicIdentifier,
      profilePictureUrl: entry.person.profilePictureUrl ?? c.profilePictureUrl,
    };
  }

  for (const { person, triggers } of byProfile.values()) {
    const { data: existing, error: readError } = await client
      .from("linkedin_commenters")
      .select("id")
      .eq("research_table_id", researchTableId)
      .eq("profile_url", person.profileUrl!)
      .maybeSingle();
    if (readError) {
      throw new Error(`Failed to read linkedin_commenters: ${readError.message}`);
    }

    let commenterId: string;
    if (existing?.id) {
      commenterId = existing.id as string;
      const { error } = await client
        .from("linkedin_commenters")
        .update({
          name: person.name,
          // Never overwrite a known value with a null from a thinner payload.
          ...(person.headline ? { headline: person.headline } : {}),
          ...(person.networkDistance
            ? { network_distance: person.networkDistance }
            : {}),
          ...(person.providerId ? { provider_id: person.providerId } : {}),
          ...(person.publicIdentifier
            ? { public_identifier: person.publicIdentifier }
            : {}),
          ...(person.profilePictureUrl
            ? { profile_picture_url: person.profilePictureUrl }
            : {}),
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", commenterId);
      if (error) {
        throw new Error(`Failed to update commenter: ${error.message}`);
      }
    } else {
      const { data, error } = await client
        .from("linkedin_commenters")
        .insert({
          research_table_id: researchTableId,
          profile_url: person.profileUrl,
          name: person.name,
          headline: person.headline,
          network_distance: person.networkDistance,
          provider_id: person.providerId,
          public_identifier: person.publicIdentifier,
          profile_picture_url: person.profilePictureUrl,
        })
        .select("id")
        .single();
      if (error) {
        throw new Error(`Failed to insert commenter: ${error.message}`);
      }
      commenterId = data.id as string;
      peopleNew += 1;
    }
    peopleUpserted += 1;

    // Triggers are append-only and keyed on (commenter, comment) so a re-run
    // over the same post is a no-op rather than a pile of duplicates.
    const byCommentId = new Map<string, Commenter>();
    for (const t of triggers) byCommentId.set(t.commentId, t);
    const rows = [...byCommentId.values()].map((t) => ({
      commenter_id: commenterId,
      comment_id: t.commentId,
      post_url: t.postUrl,
      activity_id: t.activityId,
      post_social_id: t.postSocialId,
      comment_text: t.commentText,
      commented_at: toIsoOrNull(t.commentedAt),
      is_reply: t.isReply,
      reaction_count: t.reactionCount,
      reply_count: t.replyCount,
    }));
    const { data: inserted, error: triggerError } = await client
      .from("linkedin_commenter_triggers")
      .upsert(rows, { onConflict: "commenter_id,comment_id", ignoreDuplicates: true })
      .select("id");
    if (triggerError) {
      throw new Error(`Failed to insert trigger: ${triggerError.message}`);
    }
    triggersAdded += inserted?.length ?? 0;
  }

  return { peopleUpserted, peopleNew, triggersAdded };
}

// ---------------------------------------------------------------------------
// The whole chain
// ---------------------------------------------------------------------------

export type HarvestResult = {
  postsFound: number;
  postsWithActivityId: number;
  postsProcessed: number;
  postsSkipped: Array<{ url: string; reason: string }>;
  commentsSeen: number;
  uniquePeople: number;
  byNetworkDistance: Record<string, number>;
  unipileCalls: number;
  written: HarvestWriteResult | null;
  people: Commenter[];
};

export async function harvestCommenters(
  client: SupabaseClient | null,
  opts: {
    queries?: string[];
    daysBack?: number;
    maxPosts?: number;
    maxCommentsPerPost?: number;
    includeReplies?: boolean;
    accountId?: string | null;
    /** Only when set does anything get written. */
    researchTableId?: string | null;
  },
): Promise<HarvestResult> {
  const callsBefore = unipileHarvestBudget().used;

  // Small, deliberate defaults — this drives a real account.
  const maxPosts = Math.max(1, Math.min(25, opts.maxPosts ?? 3));
  const maxCommentsPerPost = Math.max(
    1,
    Math.min(200, opts.maxCommentsPerPost ?? 25),
  );

  const discovered = await findLinkedInPosts({
    queries: opts.queries,
    daysBack: opts.daysBack,
    maxResults: Math.max(maxPosts * 3, maxPosts),
  });

  const harvestable = discovered.filter((p) => p.activityId);
  const skipped: Array<{ url: string; reason: string }> = discovered
    .filter((p) => !p.activityId)
    .map((p) => ({ url: p.url, reason: "no activity id in URL" }));

  const all: Commenter[] = [];
  let processed = 0;

  for (const post of harvestable) {
    if (processed >= maxPosts) break;
    try {
      const res = await listPostCommenters({
        postUrlOrActivityId: post.url,
        accountId: opts.accountId,
        includeReplies: opts.includeReplies,
        maxComments: maxCommentsPerPost,
      });
      all.push(...res.commenters);
      processed += 1;
    } catch (err) {
      // Fail closed on a rejection from Unipile: record it and move on, never
      // retry. A 4xx here means LinkedIn refused us for this post, and the
      // one thing worth less than a missing post is a restricted account.
      const reason =
        err instanceof UnipileHttpError
          ? `Unipile ${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      skipped.push({ url: post.url, reason });
      // A budget or auth failure will hit every remaining post identically.
      if (
        err instanceof UnipileHttpError &&
        (err.status === 401 || err.status === 403 || err.status === 429)
      ) {
        break;
      }
    }
  }

  const byNetworkDistance: Record<string, number> = {};
  const uniqueProfiles = new Set<string>();
  for (const c of all) {
    if (c.profileUrl) uniqueProfiles.add(c.profileUrl);
    const key = c.networkDistance ?? "unknown";
    byNetworkDistance[key] = (byNetworkDistance[key] ?? 0) + 1;
  }

  let written: HarvestWriteResult | null = null;
  if (opts.researchTableId && client) {
    written = await saveCommenters(client, opts.researchTableId, all);
  }

  return {
    postsFound: discovered.length,
    postsWithActivityId: harvestable.length,
    postsProcessed: processed,
    postsSkipped: skipped,
    commentsSeen: all.length,
    uniquePeople: uniqueProfiles.size,
    byNetworkDistance,
    unipileCalls: unipileHarvestBudget().used - callsBefore,
    written,
    people: all,
  };
}
