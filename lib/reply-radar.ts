import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getModel } from "@/lib/ai/provider";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import {
  resolveVoicePolicyForUser,
  type VoicePolicyPayload,
} from "@/lib/voice-policy";
import {
  computeEngagementScore,
  getUserTimeline,
  XApiError,
  type XPost,
} from "@/lib/x-client";

export type TargetAccountRow = {
  id: string;
  user_email: string;
  x_username: string;
  x_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  enabled: boolean;
  last_synced_at: string | null;
};

export type SyncTargetResult = {
  targetId: string;
  username: string;
  fetched: number;
  inserted: number;
  skipped: number;
  error?: string;
};

export type SyncUserResult = {
  userEmail: string;
  targets: SyncTargetResult[];
  totalInserted: number;
};

const LOOKBACK_HOURS = 48;
const MIN_POSTS_FOR_MEDIAN = 4;
const ABSOLUTE_FLOOR_SCORE = 20; // avoids surfacing low-noise posts from tiny accounts
const MAX_TIMELINE_SIZE = 20;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function hoursAgoIso(hours: number): string {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d.toISOString();
}

function isWithinLookback(iso: string): boolean {
  const created = new Date(iso).getTime();
  if (!Number.isFinite(created)) return false;
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  return created >= cutoff;
}

function shouldSurface(post: XPost, scoreThreshold: number): boolean {
  const score = computeEngagementScore(post.metrics);
  return score >= scoreThreshold && isWithinLookback(post.createdAt);
}

async function fetchExistingPostIds(
  client: SupabaseClient,
  userEmail: string,
  postIds: string[],
): Promise<Set<string>> {
  if (!postIds.length) return new Set();

  const { data, error } = await client
    .from("x_reply_candidates")
    .select("x_post_id")
    .eq("user_email", userEmail)
    .in("x_post_id", postIds);

  if (error) throw new Error(error.message);

  return new Set(
    ((data as Array<{ x_post_id: string }> | null) ?? []).map(
      (row) => row.x_post_id,
    ),
  );
}

async function syncTarget(
  client: SupabaseClient,
  target: TargetAccountRow,
): Promise<SyncTargetResult> {
  const base: SyncTargetResult = {
    targetId: target.id,
    username: target.x_username,
    fetched: 0,
    inserted: 0,
    skipped: 0,
  };

  let posts: XPost[];
  try {
    posts = await getUserTimeline({
      userId: target.x_user_id,
      username: target.x_username,
      sinceIso: target.last_synced_at ?? hoursAgoIso(LOOKBACK_HOURS),
      maxResults: MAX_TIMELINE_SIZE,
    });
  } catch (err) {
    return {
      ...base,
      error:
        err instanceof XApiError
          ? `X API ${err.status}${err.code ? ` (${err.code})` : ""}`
          : err instanceof Error
            ? err.message
            : "Unknown error",
    };
  }

  base.fetched = posts.length;
  if (!posts.length) {
    await client
      .from("x_target_accounts")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", target.id);
    return base;
  }

  const scores = posts.map((p) => computeEngagementScore(p.metrics));
  const medianScore = median(scores);
  const threshold = Math.max(
    ABSOLUTE_FLOOR_SCORE,
    scores.length >= MIN_POSTS_FOR_MEDIAN ? medianScore * 2 : 0,
  );

  const candidatesToInsert = posts.filter((p) => shouldSurface(p, threshold));
  if (!candidatesToInsert.length) {
    await client
      .from("x_target_accounts")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", target.id);
    return base;
  }

  const existing = await fetchExistingPostIds(
    client,
    target.user_email,
    candidatesToInsert.map((p) => p.id),
  );

  const rows = candidatesToInsert
    .filter((p) => !existing.has(p.id))
    .map((p) => ({
      user_email: target.user_email,
      target_account_id: target.id,
      x_post_id: p.id,
      post_url: p.url,
      post_text: p.text,
      post_created_at: p.createdAt,
      author_username: target.x_username,
      author_display_name: target.display_name,
      author_avatar_url: target.avatar_url,
      metrics: p.metrics,
      engagement_score: computeEngagementScore(p.metrics),
      status: "new",
    }));

  base.skipped = candidatesToInsert.length - rows.length;

  if (rows.length) {
    const { error } = await client.from("x_reply_candidates").insert(rows);
    if (error) {
      return { ...base, error: error.message };
    }
    base.inserted = rows.length;
  }

  await client
    .from("x_target_accounts")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", target.id);

  return base;
}

export async function syncUserCandidates(
  userEmail: string,
  options: { client?: SupabaseClient } = {},
): Promise<SyncUserResult> {
  const client = options.client ?? getSupabaseServiceClient();

  const { data, error } = await client
    .from("x_target_accounts")
    .select(
      "id, user_email, x_username, x_user_id, display_name, avatar_url, enabled, last_synced_at",
    )
    .eq("user_email", userEmail)
    .eq("enabled", true);

  if (error) throw new Error(error.message);

  const targets = (data as TargetAccountRow[] | null) ?? [];
  const results: SyncTargetResult[] = [];
  let totalInserted = 0;

  for (const target of targets) {
    const result = await syncTarget(client, target);
    results.push(result);
    totalInserted += result.inserted;
  }

  return { userEmail, targets: results, totalInserted };
}

// ---------------------------------------------------------------------------
// Draft generation
// ---------------------------------------------------------------------------

export type DraftAngle = "contrarian" | "add_specificity" | "sharp_question";

const ANGLE_INSTRUCTIONS: Record<DraftAngle, string> = {
  contrarian:
    "Take a sharp contrarian angle. Respectfully push back on the post's premise with a concrete counter-point. No hedging words like 'maybe', 'I think'. State the opposing view plainly.",
  add_specificity:
    "Add a specific, concrete data point, example, or number the original post is missing. Reference real engineering practice (AI code review, PR workflows, devtools) where relevant.",
  sharp_question:
    "Ask one sharp, specific question that exposes an assumption or edge case in the post. Not a soft open question — one that forces the author to think harder.",
};

const ANGLE_ORDER: DraftAngle[] = [
  "contrarian",
  "add_specificity",
  "sharp_question",
];

const MAX_REPLY_CHARS = 260;

export type CandidateForDraft = {
  id: string;
  user_email: string;
  post_text: string;
  author_username: string;
  author_display_name: string | null;
  metrics: Record<string, number>;
};

function buildReplyPrompt({
  angle,
  candidate,
  voicePolicy,
}: {
  angle: DraftAngle;
  candidate: CandidateForDraft;
  voicePolicy: VoicePolicyPayload;
}): { system: string; prompt: string } {
  const system = [
    "You draft replies to X (Twitter) posts on behalf of a founder at Kodus, an AI code review devtool for engineering teams.",
    "Rules:",
    `- Maximum ${MAX_REPLY_CHARS} characters. Hard limit.`,
    "- No hashtags. No emojis unless they materially help. No 'Great post!' or any sycophantic opener.",
    "- One clear point of view. Plain, direct language. Sound like a human, not marketing.",
    "- Do not pitch Kodus or any product. The goal is to add value and provoke replies.",
    "- Output ONLY the reply text. No quotes, no prefix, no explanation.",
    "",
    "Voice policy:",
    voicePolicy.prompt,
    "",
    `Angle for this reply: ${ANGLE_INSTRUCTIONS[angle]}`,
  ].join("\n");

  const authorLabel = candidate.author_display_name
    ? `${candidate.author_display_name} (@${candidate.author_username})`
    : `@${candidate.author_username}`;

  const prompt = [
    `Original post by ${authorLabel}:`,
    `"""${candidate.post_text}"""`,
    "",
    "Draft the reply now.",
  ].join("\n");

  return { system, prompt };
}

function sanitizeDraft(text: string): string {
  const trimmed = text.trim().replace(/^["']+|["']+$/g, "").trim();
  if (trimmed.length <= MAX_REPLY_CHARS) return trimmed;
  const truncated = trimmed.slice(0, MAX_REPLY_CHARS - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > MAX_REPLY_CHARS * 0.6
    ? truncated.slice(0, lastSpace)
    : truncated
  ).trimEnd();
}

export async function generateDraftsForCandidate({
  candidate,
  voicePolicy,
}: {
  candidate: CandidateForDraft;
  voicePolicy: VoicePolicyPayload;
}): Promise<Array<{ angle: DraftAngle; text: string }>> {
  const model = getModel();

  const results = await Promise.all(
    ANGLE_ORDER.map(async (angle) => {
      try {
        const { system, prompt } = buildReplyPrompt({
          angle,
          candidate,
          voicePolicy,
        });
        const { text } = await generateText({ model, system, prompt });
        return { angle, text: sanitizeDraft(text) };
      } catch (err) {
        console.error(
          `[reply-radar] draft generation failed for ${candidate.id} / ${angle}`,
          err,
        );
        return null;
      }
    }),
  );

  return results.filter(
    (item): item is { angle: DraftAngle; text: string } =>
      Boolean(item && item.text),
  );
}

export async function generateAndStoreDraftsForUser(
  userEmail: string,
  options: { limit?: number; client?: SupabaseClient } = {},
): Promise<{ processed: number; failed: number }> {
  const client = options.client ?? getSupabaseServiceClient();
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);

  const { data, error } = await client
    .from("x_reply_candidates")
    .select(
      "id, user_email, post_text, author_username, author_display_name, metrics",
    )
    .eq("user_email", userEmail)
    .eq("status", "new")
    .order("engagement_score", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  const candidates = (data as CandidateForDraft[] | null) ?? [];
  if (!candidates.length) {
    return { processed: 0, failed: 0 };
  }

  const voicePolicy = await resolveVoicePolicyForUser(userEmail);

  let processed = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const drafts = await generateDraftsForCandidate({
      candidate,
      voicePolicy,
    });

    if (!drafts.length) {
      failed += 1;
      continue;
    }

    const rows = drafts.map((draft, index) => ({
      candidate_id: candidate.id,
      user_email: candidate.user_email,
      position: index + 1,
      angle: draft.angle,
      draft_text: draft.text,
    }));

    const { error: insertError } = await client
      .from("x_reply_drafts")
      .insert(rows);

    if (insertError) {
      console.error(
        `[reply-radar] draft insert failed for ${candidate.id}`,
        insertError,
      );
      failed += 1;
      continue;
    }

    const { error: updateError } = await client
      .from("x_reply_candidates")
      .update({ status: "drafted" })
      .eq("id", candidate.id);

    if (updateError) {
      console.error(
        `[reply-radar] candidate status update failed for ${candidate.id}`,
        updateError,
      );
    }

    processed += 1;
  }

  return { processed, failed };
}

export async function syncAllUsersCandidates(): Promise<SyncUserResult[]> {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from("x_target_accounts")
    .select("user_email")
    .eq("enabled", true);

  if (error) throw new Error(error.message);

  const emails = Array.from(
    new Set(
      ((data as Array<{ user_email: string }> | null) ?? [])
        .map((row) => row.user_email)
        .filter((email): email is string => Boolean(email)),
    ),
  );

  const results: SyncUserResult[] = [];
  for (const email of emails) {
    try {
      results.push(await syncUserCandidates(email, { client }));
    } catch (err) {
      results.push({
        userEmail: email,
        targets: [],
        totalInserted: 0,
      });
      console.error(`[reply-radar] sync failed for ${email}`, err);
    }
  }

  return results;
}
