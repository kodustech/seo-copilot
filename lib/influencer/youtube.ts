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
  if (parsed.length > YOUTUBE_MAX_BLOCKS) {
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
