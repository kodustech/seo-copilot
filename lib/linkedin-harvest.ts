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
  extractLinkedInActivityId,
  getUnipilePost,
  isUnipileConfigured,
  linkedInAccountIdentity,
  listUnipilePostComments,
  normalizeLinkedInIdentity,
  unipileHarvestBudget,
  UnipileHarvestLimitError,
  UnipileHttpError,
  UnipileTimeoutError,
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

/**
 * Ceiling on topic queries per call.
 *
 * Every query is a paid Exa search, and the default sweep only ever uses 13.
 * Enforced here rather than only in the tool schema so no caller — MCP, cron
 * or future code — can turn one invocation into hundreds of billed searches.
 */
export const MAX_QUERIES = 10;

export async function findLinkedInPosts(opts: {
  queries?: string[];
  daysBack?: number;
  maxResults?: number;
}): Promise<DiscoveredPost[]> {
  // Validate the input before complaining about configuration — a caller who
  // passed 40 topics should be told that, not sent to check their API keys.
  const queries = opts.queries?.map((q) => q.trim()).filter(Boolean);
  if (queries && queries.length > MAX_QUERIES) {
    throw new Error(
      `Too many queries: ${queries.length}. Each one is a paid Exa search — pass at most ${MAX_QUERIES}.`,
    );
  }

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
    queries,
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
  isCompany: boolean;
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
  // normalizeLinkedInIdentity falls back to splitting the raw string on
  // [/?#], so anything that is not an /in/ or /pub/ URL — a company page, a
  // non-LinkedIn link — comes back as the scheme, "https:". Building a key
  // from that gave every such commenter the SAME profile URL and merged
  // distinct people into one row. Only a plausible vanity slug is an
  // identity; anything else means we could not identify this person.
  if (!slug || !/^[\p{L}\p{N}][\p{L}\p{N}_-]{2,}$/u.test(slug)) return null;
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
    isCompany: c.isCompany,
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

  const identity = await linkedInAccountIdentity();
  const accountId = opts.accountId?.trim() || identity.accountId;
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
    commenters: comments
      // Never harvest the account doing the harvesting. Gabriel commenting on
      // a post he is also collecting from would otherwise land in his own
      // cold queue.
      .filter(
        (c) =>
          !identity.providerUserId ||
          c.providerId?.toLowerCase() !== identity.providerUserId.toLowerCase(),
      )
      .map((c) =>
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
 * Build the commenter upsert payloads, grouped by which optional columns they
 * carry.
 *
 * Two invariants live here, both load-bearing:
 *
 * 1. A null optional field is OMITTED, never sent as null. A column absent
 *    from the payload is absent from the ON CONFLICT SET list, so a thin
 *    sighting cannot blank a headline or network distance that another
 *    harvest just wrote. Coalescing in memory against a pre-read only held
 *    single-threaded; this holds in any order.
 * 2. Rows are grouped by key set, because PostgREST rejects a bulk upsert
 *    whose objects have differing keys (PGRST102).
 */
export function commenterUpsertGroups(
  researchTableId: string,
  people: Commenter[],
  now: string,
): Map<string, Array<Record<string, unknown>>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const person of people) {
    const row: Record<string, unknown> = {
      research_table_id: researchTableId,
      profile_url: person.profileUrl,
      name: person.name,
      last_seen_at: now,
      updated_at: now,
    };
    if (person.headline) row.headline = person.headline;
    if (person.networkDistance) row.network_distance = person.networkDistance;
    if (person.providerId) row.provider_id = person.providerId;
    if (person.publicIdentifier) row.public_identifier = person.publicIdentifier;
    if (person.profilePictureUrl) {
      row.profile_picture_url = person.profilePictureUrl;
    }
    const shape = Object.keys(row).sort().join(",");
    const group = groups.get(shape) ?? [];
    group.push(row);
    groups.set(shape, group);
  }
  return groups;
}

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
    // A company page can comment. This table is people — a brand account has
    // no role, no degree worth routing on, and nobody to message.
    if (!c.profileUrl || !c.name || c.isCompany) continue;
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

  const profileUrls = [...byProfile.keys()];
  if (profileUrls.length === 0) {
    return { peopleUpserted: 0, peopleNew: 0, triggersAdded: 0 };
  }

  // One read for everyone, not one per person. This is only used to report
  // how many people are new — the writes below do not depend on it, because
  // a pre-read is stale the moment another harvest writes. Under concurrency
  // the count can be off by the rows the other run created; the data cannot.
  const existingProfiles = new Set<string>();
  for (let i = 0; i < profileUrls.length; i += 200) {
    const chunk = profileUrls.slice(i, i + 200);
    const { data, error } = await client
      .from("linkedin_commenters")
      .select("profile_url")
      .eq("research_table_id", researchTableId)
      .in("profile_url", chunk);
    if (error) {
      throw new Error(`Failed to read linkedin_commenters: ${error.message}`);
    }
    for (const row of data ?? []) existingProfiles.add(row.profile_url as string);
  }

  const now = new Date().toISOString();

  // Upsert rather than insert, because two harvests running at once would
  // both read "no such row" and both insert, and the loser of that race took
  // a unique violation that failed the whole harvest.
  //
  // Null columns are omitted rather than coalesced in memory. A value merged
  // against the pre-read is merged against a snapshot that a concurrent
  // harvest may already have replaced, so the "a thinner sighting cannot
  // blank a headline we know" guarantee only held single-threaded. A column
  // that is absent from the payload is absent from the ON CONFLICT SET list,
  // so it cannot be blanked by anyone, in any order.
  //
  // Rows are grouped by which optional columns they carry: PostgREST rejects
  // a bulk upsert whose objects have differing key sets (PGRST102), so one
  // request per shape rather than one big heterogeneous batch.
  const groups = commenterUpsertGroups(
    researchTableId,
    [...byProfile.values()].map((e) => e.person),
    now,
  );

  const idByProfile = new Map<string, string>();
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 200) {
      const chunk = group.slice(i, i + 200);
      const { data, error } = await client
        .from("linkedin_commenters")
        .upsert(chunk, { onConflict: "research_table_id,profile_url" })
        .select("id, profile_url");
      if (error) {
        throw new Error(`Failed to upsert commenters: ${error.message}`);
      }
      for (const row of data ?? []) {
        idByProfile.set(row.profile_url as string, row.id as string);
      }
    }
  }
  peopleUpserted = idByProfile.size;
  peopleNew = profileUrls.filter((u) => !existingProfiles.has(u)).length;

  // Triggers are append-only and keyed on (commenter, comment) so a re-run
  // over the same post is a no-op rather than a pile of duplicates.
  const triggerRows: Array<Record<string, unknown>> = [];
  for (const [profileUrl, { triggers }] of byProfile) {
    const commenterId = idByProfile.get(profileUrl);
    if (!commenterId) continue;
    const byCommentId = new Map<string, Commenter>();
    for (const t of triggers) byCommentId.set(t.commentId, t);
    for (const t of byCommentId.values()) {
      triggerRows.push({
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
      });
    }
  }

  for (let i = 0; i < triggerRows.length; i += 500) {
    const chunk = triggerRows.slice(i, i + 500);
    const { data, error } = await client
      .from("linkedin_commenter_triggers")
      .upsert(chunk, {
        onConflict: "commenter_id,comment_id",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) {
      throw new Error(`Failed to insert triggers: ${error.message}`);
    }
    triggersAdded += data?.length ?? 0;
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
  /** Brand accounts dropped: this list is people. */
  excludedCompanies: number;
  /** Comments with no resolvable name or profile — a shape-change canary. */
  excludedNoIdentity: number;
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
      // A budget or auth failure will hit every remaining post identically,
      // so carrying on just fills `skipped` with the same sentence N times.
      if (
        err instanceof UnipileHarvestLimitError ||
        // A degraded Unipile times out every call, so continuing means
        // burning the full deadline once per remaining post — 25 posts at
        // 30s is a harvest that takes 12 minutes to fail.
        err instanceof UnipileTimeoutError ||
        (err instanceof UnipileHttpError &&
          (err.status === 401 || err.status === 403 || err.status === 429))
      ) {
        break;
      }
    }
  }

  // Filter once, here, so the preview and the write cannot disagree. Doing it
  // only at the write step meant `people` and the counts advertised brand
  // accounts as contactable prospects that were then silently not stored —
  // and anything consuming `people` would have aimed outreach at a logo.
  const people: Commenter[] = [];
  let excludedCompanies = 0;
  let excludedNoIdentity = 0;
  for (const c of all) {
    if (c.isCompany) {
      excludedCompanies += 1;
      continue;
    }
    if (!c.profileUrl || !c.name) {
      excludedNoIdentity += 1;
      continue;
    }
    people.push(c);
  }

  const byNetworkDistance: Record<string, number> = {};
  const uniqueProfiles = new Set<string>();
  for (const c of people) {
    uniqueProfiles.add(c.profileUrl!);
    const key = c.networkDistance ?? "unknown";
    byNetworkDistance[key] = (byNetworkDistance[key] ?? 0) + 1;
  }

  // A comment we could not attach a name and profile to means the response
  // shape moved. Say so loudly — the alternative is a harvest that quietly
  // returns fewer people than it saw and looks like it worked.
  if (excludedNoIdentity > 0) {
    console.warn(
      `[linkedin-harvest] ${excludedNoIdentity} of ${all.length} comment(s) had no resolvable name or profile URL — check the Unipile response shape.`,
    );
  }

  let written: HarvestWriteResult | null = null;
  if (opts.researchTableId && client) {
    written = await saveCommenters(client, opts.researchTableId, people);
  }

  return {
    postsFound: discovered.length,
    postsWithActivityId: harvestable.length,
    postsProcessed: processed,
    postsSkipped: skipped,
    commentsSeen: all.length,
    excludedCompanies,
    excludedNoIdentity,
    uniquePeople: uniqueProfiles.size,
    byNetworkDistance,
    unipileCalls: unipileHarvestBudget().used - callsBefore,
    written,
    people,
  };
}
