/**
 * YouTube channel: the rules that keep a synthetic video presenter honest,
 * cheap, and publishable.
 *
 * Pipeline, in order: script blocks (agent) → avatar render (HeyGen) →
 * composite (slides + bubble + captions + music) → upload (unlisted) →
 * person confirms YouTube's "altered content" checkbox → public.
 *
 * Costs are real money per rendered second (measured 2026-09-19: ~0.038
 * credits/s for a photo avatar on Avatar IV, 1.0 per new avatar look), so
 * every render passes through the weekly cap before it runs.
 */

export const YOUTUBE_MAX_BLOCKS = 8;
export const YOUTUBE_MIN_BLOCKS = 3;
export const YOUTUBE_MIN_BLOCK_CHARS = 20;
export const YOUTUBE_MAX_BLOCK_CHARS = 600;
/** Measured credits per rendered second (photo avatar, Avatar IV). */
export const YOUTUBE_COST_PER_VIDEO_SECOND = 0.04;
/** One-off cost of training a new avatar look. */
export const YOUTUBE_COST_PER_AVATAR_LOOK = 1.0;
/** Hard stop per persona per ISO week, in credits. Approve-first still spends. */
export const YOUTUBE_WEEKLY_CAP_CREDITS = 12;
/** Uploads always land unlisted: YouTube's AI-content checkbox has no API. */
export const YOUTUBE_UPLOAD_PRIVACY = "unlisted" as const;
/** The platform-side AI label can only be set by a person in Studio. */
export const YOUTUBE_AI_DISCLOSURE_MANUAL = true;

export function parseVideoBlocks(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const blocks = input
    .filter((b): b is string => typeof b === "string")
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return blocks.length ? blocks : null;
}

/** Human-readable problems with a script; empty means it can render. */
export function validateVideoScript(blocks: unknown): string[] {
  const parsed = parseVideoBlocks(blocks);
  if (!parsed) return ["video_script_missing: queue 1-8 spoken blocks, not an article."];
  const issues: string[] = [];
  // The composite needs an intro clip plus at least one body clip, and every
  // prompt promises "3-8 spoken blocks" — fewer would render spend into a
  // video that can never be assembled.
  if (parsed.length < YOUTUBE_MIN_BLOCKS) {
    issues.push(`too_few_blocks: ${parsed.length} < ${YOUTUBE_MIN_BLOCKS}; the composite needs an intro plus body segments.`);
  }  if (parsed.length > YOUTUBE_MAX_BLOCKS) {
    issues.push(`too_many_blocks: ${parsed.length} > ${YOUTUBE_MAX_BLOCKS}; one idea per block.`);
  }
  parsed.forEach((block, i) => {
    if (block.length < YOUTUBE_MIN_BLOCK_CHARS) {
      issues.push(`block_${i + 1}_too_short: ${block.length} chars; a block must carry a full spoken thought.`);
    }
    if (block.length > YOUTUBE_MAX_BLOCK_CHARS) {
      issues.push(
        `block_${i + 1}_too_long: ${block.length} chars; split it — long reads desync the mouth and lose retention.`,
      );
    }
  });
  return issues;
}

/** Credits a render is expected to burn, before it runs. */
export function estimateVideoCost(totalSeconds: number): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  return Math.ceil(totalSeconds * YOUTUBE_COST_PER_VIDEO_SECOND * 100) / 100;
}

export function withinWeeklyCap(spentThisWeekCredits: number, estimateCredits: number): boolean {
  return spentThisWeekCredits + estimateCredits <= YOUTUBE_WEEKLY_CAP_CREDITS;
}

export function buildVideoDescription(input: {
  canonicalUrl?: string | null;
  musicCredit?: string | null;
  siteUrl?: string | null;
  aiNote?: string | null;
}): string {
  const lines = [
    input.aiNote ?? "AI-generated presenter; scripted and reviewed by a person.",
  ];
  if (input.canonicalUrl) lines.push(`Full post: ${input.canonicalUrl}`);
  if (input.siteUrl) lines.push(`More: ${input.siteUrl}`);
  if (input.musicCredit) lines.push(`Music: ${input.musicCredit}`);
  return lines.join("\n");
}

export type YoutubeChannelConfig = {
  avatarId: string | null;
  voiceId: string | null;
  musicUrl: string | null;
  siteUrl: string | null;
};

/** Avatar + voice live on the channel: one presenter per channel, always. */
export function youtubeChannelConfig(channel: {
  channel_config: Record<string, unknown>;
}): YoutubeChannelConfig {
  const cfg = channel.channel_config;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    avatarId: text(cfg.youtube_avatar_id),
    voiceId: text(cfg.youtube_voice_id),
    musicUrl: text(cfg.youtube_music_url),
    siteUrl: text(cfg.youtube_site_url),
  };
}

export function youtubeChannelReady(cfg: YoutubeChannelConfig): string | null {
  if (!cfg.avatarId) return "Pick the avatar look (youtube_avatar_id) this channel presents as.";
  if (!cfg.voiceId) return "Pick the voice (youtube_voice_id) this channel speaks with.";
  return null;
}

export const YOUTUBE_MAX_SLIDES = 7;

export type VideoSlideSpec = {
  title: string;
  rows: string[];
  note?: string | null;
};

/**
 * Slide outlines ride with the script (one per body block — the intro has
 * no slide). The worker renders pixels from these; the agent never touches
 * layout, fonts, or colors, so every video of the channel looks related.
 */
export function parseSlideSpecs(input: unknown): VideoSlideSpec[] | null {
  if (!Array.isArray(input)) return null;
  const specs: VideoSlideSpec[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.replace(/\s+/g, " ").trim() : "";
    const rows = Array.isArray(rec.rows)
      ? rec.rows
          .filter((r): r is string => typeof r === "string")
          .map((r) => r.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];
    const note = typeof rec.note === "string" && rec.note.trim() ? rec.note.trim() : null;
    if (!title || !rows.length) return null;
    specs.push({ title, rows, note });
  }
  return specs.length ? specs : null;
}

export function validateSlideSpecs(slides: unknown, blockCount: number): string[] {
  const parsed = parseSlideSpecs(slides);
  if (!parsed) return ["slides_missing: one outline per body block (title + up to 6 short rows)."];
  if (parsed.length > YOUTUBE_MAX_SLIDES) return [`too_many_slides: ${parsed.length} > ${YOUTUBE_MAX_SLIDES}.`];
  // Block 1 is the full-frame intro; every block after it gets a slide.
  if (parsed.length !== blockCount - 1) {
    return [
      `slides_mismatch: ${parsed.length} outlines for ${blockCount} blocks — the intro needs none, every other block needs exactly one.`,
    ];
  }
  return [];
}
