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
    "Push back on a specific claim or assumption the post makes. Name what you disagree with and state your alternative in plain language. Must reference something concrete from the post itself. Never hedge with 'maybe' or 'in my opinion'.",
  add_specificity:
    "Name one real, known-to-be-true specific: a tool, a standard, a well-documented behavior, a named pattern. NEVER invent percentages, survey results, customer stories, or studies. If you can't cite something real, skip this angle and write nothing.",
  sharp_question:
    "Ask one question that exposes a hidden assumption or edge case in the post. Must be specific enough that answering it requires thinking. Never generic like 'have you considered X'.",
};

const ANGLE_ORDER: DraftAngle[] = [
  "contrarian",
  "add_specificity",
  "sharp_question",
];

const MAX_REPLY_CHARS = 260;
const TARGET_REPLY_CHARS = 220;

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
    "You draft replies to X (Twitter) posts on behalf of a founder in the devtools space.",
    "",
    "HARD CONSTRAINTS",
    `- Target length: ${TARGET_REPLY_CHARS} chars. Absolute maximum: ${MAX_REPLY_CHARS}. Never get truncated mid-sentence — finish the thought.`,
    "- Write in FIRST PERSON when making a claim ('I', 'my'). Avoid 'we' or 'teams'. You are one founder replying, not a marketing account.",
    "- Do NOT invent data, metrics, customer stories, studies, or percentages. If you write '20%', '30%', 'X hours', '2-3 days', delete it.",
    "- Do NOT pitch Kodus or any product. No CTAs. No links. No sign-offs.",
    "- Do NOT compliment the post. No 'Great thread', 'Nice take', 'This is so true', 'Love this'.",
    "- Do NOT use hashtags or emojis.",
    "",
    "BANNED WORDS AND PHRASES (if any appear, rewrite)",
    "- Significant, long-term, incredible, leverage, robust, powerful, seamless, scalable, game-changer",
    "- The real challenge, the key takeaway, the main point, the bottom line, at the end of the day",
    "- We've seen, we've found, in our experience, teams invest, companies are, organizations need",
    "- It's not about X, it's about Y (contrast framing)",
    "- Technical debt, core value, holistic, paradigm, ecosystem",
    "",
    "STYLE",
    "- Sound like a real person typing in Slack. Short sentences. No corporate rhythm.",
    "- Reference something specific from the ORIGINAL POST (a word, a claim, a detail) so the reader sees it's a real engagement, not a template.",
    "- One clear point. Don't try to say 3 things.",
    "- Output ONLY the reply text. No quotes around it. No prefix. No explanation of what you did.",
    "",
    "VOICE POLICY",
    voicePolicy.prompt,
    "",
    "ANGLE FOR THIS REPLY",
    ANGLE_INSTRUCTIONS[angle],
  ].join("\n");

  const authorLabel = candidate.author_display_name
    ? `${candidate.author_display_name} (@${candidate.author_username})`
    : `@${candidate.author_username}`;

  const prompt = [
    `Original post by ${authorLabel}:`,
    `"""${candidate.post_text}"""`,
    "",
    `Draft the reply now. Finish your thought before ${TARGET_REPLY_CHARS} chars.`,
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

// Fingerprints of AI-flavored replies that slip past the prompt.
const BANNED_REPLY_PATTERNS: RegExp[] = [
  /\bsignificant(?:ly)?\b/i,
  /\blong-term\b/i,
  /\bincredible\b/i,
  /\bleverage\b/i,
  /\brobust\b/i,
  /\bseamless\b/i,
  /\bscalable\b/i,
  /\bgame[- ]changer\b/i,
  /\btechnical debt\b/i,
  /\bcore value\b/i,
  /\bholistic\b/i,
  /\bparadigm\b/i,
  /\becosystem\b/i,
  /\bthe real challenge\b/i,
  /\bthe (?:key|main) (?:takeaway|point)\b/i,
  /\bthe bottom line\b/i,
  /\bat the end of the day\b/i,
  /\bin (?:our|my) experience,/i,
  /\bwe['']?ve seen\b/i,
  /\bwe['']?ve found\b/i,
  /\bteams invest\b/i,
  /\b(?:companies|organizations|teams) (?:are|need)\b/i,
  /\bit['']?s not (?:about|just) .+ it['']?s\b/i,
];

// Crude detector for invented quantitative claims ("20-30% more time",
// "saved 5 hours", "3x faster"). Anything like a percentage or multiplier
// paired with a verb should be rejected unless it came from the source post.
const INVENTED_DATA_PATTERNS: RegExp[] = [
  /\b\d+\s*[-–]\s*\d+\s*%/,
  /\b\d+(?:\.\d+)?\s*%\s+(?:more|less|fewer|faster|slower|higher|lower|of)\b/i,
  /\b\d+x\s+(?:faster|slower|more|less)\b/i,
  /\b\d+\s+(?:hours?|days?|weeks?|months?)\s+(?:faster|slower|saved|less|more)\b/i,
];

function draftLooksAiGenerated(text: string, sourcePost: string): {
  ok: boolean;
  reason?: string;
} {
  for (const pattern of BANNED_REPLY_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: `banned phrase: ${pattern}` };
    }
  }

  for (const pattern of INVENTED_DATA_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    // If the exact match also appears in the source post, it's fine to quote.
    if (!sourcePost.toLowerCase().includes(match[0].toLowerCase())) {
      return { ok: false, reason: `invented stat: ${match[0]}` };
    }
  }

  // Sycophantic openers
  if (/^(great|nice|love this|this is so true|amazing|interesting take)\b/i.test(text.trim())) {
    return { ok: false, reason: "sycophantic opener" };
  }

  return { ok: true };
}

export async function generateDraftsForCandidate({
  candidate,
  voicePolicy,
}: {
  candidate: CandidateForDraft;
  voicePolicy: VoicePolicyPayload;
}): Promise<Array<{ angle: DraftAngle; text: string }>> {
  const model = getModel();

  const MAX_REROLL_ATTEMPTS = 2;

  const results = await Promise.all(
    ANGLE_ORDER.map(async (angle) => {
      for (let attempt = 0; attempt <= MAX_REROLL_ATTEMPTS; attempt += 1) {
        try {
          const { system, prompt } = buildReplyPrompt({
            angle,
            candidate,
            voicePolicy,
          });
          const { text } = await generateText({ model, system, prompt });
          const clean = sanitizeDraft(text);
          if (!clean) continue;

          const check = draftLooksAiGenerated(clean, candidate.post_text);
          if (check.ok) {
            return { angle, text: clean };
          }
          console.warn(
            `[reply-radar] rejecting draft for ${candidate.id} / ${angle} (${check.reason}), reroll ${attempt + 1}/${MAX_REROLL_ATTEMPTS}`,
          );
        } catch (err) {
          console.error(
            `[reply-radar] draft generation failed for ${candidate.id} / ${angle}`,
            err,
          );
          return null;
        }
      }
      return null;
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
