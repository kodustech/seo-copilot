/**
 * YouTube channel: the rules for a long-form synthetic presenter.
 *
 * Pipeline, in order: spoken blocks + one visual per block (agent) → avatar
 * clips (HeyGen) → composite (face cam, or slide with the avatar in a corner
 * bubble; captions; music) → upload with YouTube's altered/synthetic flag set
 * → public, unless the channel asks for less or YouTube holds the upload
 * private (an API project that has not passed YouTube's audit).
 *
 * Costs are real money per rendered second (measured 2026-09-19: ~0.038
 * credits/s for a photo avatar on Avatar IV, 1.0 per new avatar look), so
 * every render passes the channel's weekly budget before it runs.
 */
import { z } from "zod";

export const YOUTUBE_MIN_BLOCKS = 3;
export const YOUTUBE_MAX_BLOCKS = 12;
export const YOUTUBE_MIN_BLOCK_CHARS = 20;
export const YOUTUBE_MAX_BLOCK_CHARS = 1200;
/** Spoken pace of the POC render (310 words in 104s, 2026-09-19), rounded down. */
export const YOUTUBE_WORDS_PER_SECOND = 2.9;
export const YOUTUBE_DEFAULT_TARGET_MINUTES = 4.5;
/** A script within this many minutes of the target is accepted. */
export const YOUTUBE_LENGTH_TOLERANCE_MINUTES = 1;
/** Measured credits per rendered second (photo avatar, Avatar IV). */
export const YOUTUBE_COST_PER_VIDEO_SECOND = 0.04;
/** One-off cost of training a new avatar look. */
export const YOUTUBE_COST_PER_AVATAR_LOOK = 1.0;
/** Defaults for the per-channel limits an operator can change. */
export const YOUTUBE_DEFAULT_WEEKLY_BUDGET_CREDITS = 12;
export const YOUTUBE_DEFAULT_MAX_VIDEOS_PER_WEEK = 1;

export const YOUTUBE_PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACY_STATUSES)[number];
/** layouts: the agent fills a fixed set of slide templates. html: it designs each slide itself. */
export const YOUTUBE_SLIDE_MODES = ["layouts", "html"] as const;
export type YoutubeSlideMode = (typeof YOUTUBE_SLIDE_MODES)[number];
/** HeyGen photo-avatar expressiveness (Avatar IV). HeyGen's own default is "low". */
export const YOUTUBE_EXPRESSIVENESS = ["high", "medium", "low"] as const;
export type YoutubeExpressiveness = (typeof YOUTUBE_EXPRESSIVENESS)[number];
export const YOUTUBE_RESOLUTIONS = ["720p", "1080p"] as const;
export type YoutubeResolution = (typeof YOUTUBE_RESOLUTIONS)[number];

export function parseVideoBlocks(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const blocks = input
    .filter((b): b is string => typeof b === "string")
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return blocks.length ? blocks : null;
}

export function countSpokenWords(blocks: string[]): number {
  return blocks.reduce((sum, b) => sum + b.split(/\s+/).filter(Boolean).length, 0);
}

export function estimateSpeechSeconds(blocks: string[]): number {
  return Math.round(countSpokenWords(blocks) / YOUTUBE_WORDS_PER_SECOND);
}

/** Structural and spoken-text problems with a script; empty means it can render. */
export function validateVideoScript(blocks: unknown): string[] {
  const parsed = parseVideoBlocks(blocks);
  if (!parsed) return [`video_script_missing: queue ${YOUTUBE_MIN_BLOCKS}-${YOUTUBE_MAX_BLOCKS} spoken blocks, not an article.`];
  const issues: string[] = [];
  if (parsed.length < YOUTUBE_MIN_BLOCKS) {
    issues.push(`too_few_blocks: ${parsed.length} < ${YOUTUBE_MIN_BLOCKS}; open on camera, then build the idea over at least two more blocks.`);
  }
  if (parsed.length > YOUTUBE_MAX_BLOCKS) {
    issues.push(`too_many_blocks: ${parsed.length} > ${YOUTUBE_MAX_BLOCKS}; merge blocks that make the same point.`);
  }
  parsed.forEach((block, i) => {
    const n = i + 1;
    if (block.length < YOUTUBE_MIN_BLOCK_CHARS) {
      issues.push(`block_${n}_too_short: ${block.length} chars; a block must carry a full spoken thought.`);
    }
    if (block.length > YOUTUBE_MAX_BLOCK_CHARS) {
      issues.push(`block_${n}_too_long: ${block.length} chars (max ${YOUTUBE_MAX_BLOCK_CHARS}); split it where the visual changes.`);
    }
    // The avatar reads every character aloud: markup and links come out as noise.
    if (/[*#`]|^\s*[-•]\s/.test(block)) {
      issues.push(`block_${n}_markup: the avatar would read the symbols aloud; write plain spoken sentences.`);
    }
    if (/https?:\/\/|www\./i.test(block)) {
      issues.push(`block_${n}_url: say the site the way a person would ("agentwrotethis dot dev"); the link goes in canonical_url.`);
    }
  });
  return issues;
}

/**
 * Length against the channel's target. Checked when the draft is queued, not
 * at render: a target changed after review must not strand an approved script.
 */
export function validateVideoLength(blocks: string[], targetMinutes: number): string[] {
  const seconds = estimateSpeechSeconds(blocks);
  const words = countSpokenWords(blocks);
  const min = Math.max(60, (targetMinutes - YOUTUBE_LENGTH_TOLERANCE_MINUTES) * 60);
  const max = (targetMinutes + YOUTUBE_LENGTH_TOLERANCE_MINUTES) * 60;
  const targetWords = Math.round(targetMinutes * 60 * YOUTUBE_WORDS_PER_SECOND);
  if (seconds < min) {
    return [
      `video_too_short: ~${seconds}s (${words} words); this channel aims at ~${targetMinutes} min (≈${targetWords} words). Add substance, not padding: a concrete example, the failure that taught you this, the counter-argument.`,
    ];
  }
  if (seconds > max) {
    return [`video_too_long: ~${seconds}s (${words} words); this channel aims at ~${targetMinutes} min (≈${targetWords} words). Cut the weakest idea.`];
  }
  return [];
}

/** Credits a render is expected to burn, before it runs. */
export function estimateVideoCost(totalSeconds: number): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  return Math.ceil(totalSeconds * YOUTUBE_COST_PER_VIDEO_SECOND * 100) / 100;
}

export type VideoUsage = { credits: number; videos: number };

/**
 * Why this render may not start now, or null when it fits. `fresh` is a render
 * that has not created any clip yet: only those count against the video limit,
 * so a parked render always resumes.
 */
export function weeklyLimitReason(
  usage: VideoUsage,
  estimateCredits: number,
  cfg: Pick<YoutubeChannelConfig, "weeklyBudgetCredits" | "maxVideosPerWeek">,
  fresh: boolean,
): string | null {
  if (fresh && usage.videos >= cfg.maxVideosPerWeek) {
    return `Weekly video limit reached (${usage.videos}/${cfg.maxVideosPerWeek} videos).`;
  }
  if (usage.credits + estimateCredits > cfg.weeklyBudgetCredits) {
    return `Weekly video budget reached (${usage.credits}/${cfg.weeklyBudgetCredits} credits; this render needs ~${estimateCredits}).`;
  }
  return null;
}

export function buildVideoDescription(input: {
  canonicalUrl?: string | null;
  musicCredit?: string | null;
  siteUrl?: string | null;
  aiNote?: string | null;
}): string {
  const lines = [input.aiNote ?? "AI-generated presenter; scripted by an AI agent and reviewed by a person."];
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
  privacy: YoutubePrivacy;
  weeklyBudgetCredits: number;
  /** 0 pauses rendering without disconnecting the channel. */
  maxVideosPerWeek: number;
  targetMinutes: number;
  slideMode: YoutubeSlideMode;
  /** Sent to HeyGen only when set: the field is photo-avatar only. */
  expressiveness: YoutubeExpressiveness | null;
  motionPrompt: string | null;
  voiceSpeed: number | null;
  resolution: YoutubeResolution;
  /** Operator's editorial direction for this channel's videos. */
  direction: string | null;
};

function pick<T extends string>(allowed: readonly T[], v: unknown, fallback: T): T;
function pick<T extends string>(allowed: readonly T[], v: unknown, fallback: null): T | null;
function pick<T extends string>(allowed: readonly T[], v: unknown, fallback: T | null): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function numberIn(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Avatar + voice live on the channel: one presenter per channel, always. */
export function youtubeChannelConfig(channel: { channel_config: Record<string, unknown> }): YoutubeChannelConfig {
  const cfg = channel.channel_config;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    avatarId: text(cfg.youtube_avatar_id),
    voiceId: text(cfg.youtube_voice_id),
    musicUrl: text(cfg.youtube_music_url),
    siteUrl: text(cfg.youtube_site_url),
    privacy: pick(YOUTUBE_PRIVACY_STATUSES, cfg.youtube_privacy, "public"),
    weeklyBudgetCredits: numberIn(cfg.youtube_weekly_budget_credits, 0, 1000) ?? YOUTUBE_DEFAULT_WEEKLY_BUDGET_CREDITS,
    maxVideosPerWeek: Math.floor(numberIn(cfg.youtube_max_videos_per_week, 0, 50) ?? YOUTUBE_DEFAULT_MAX_VIDEOS_PER_WEEK),
    targetMinutes: numberIn(cfg.youtube_target_minutes, 1, 15) ?? YOUTUBE_DEFAULT_TARGET_MINUTES,
    slideMode: pick(YOUTUBE_SLIDE_MODES, cfg.youtube_slide_mode, "layouts"),
    expressiveness: pick(YOUTUBE_EXPRESSIVENESS, cfg.youtube_expressiveness, null),
    motionPrompt: text(cfg.youtube_motion_prompt),
    voiceSpeed: numberIn(cfg.youtube_voice_speed, 0.5, 1.5),
    resolution: pick(YOUTUBE_RESOLUTIONS, cfg.youtube_resolution, "720p"),
    direction: text(cfg.youtube_direction),
  };
}

export function youtubeChannelReady(cfg: Pick<YoutubeChannelConfig, "avatarId" | "voiceId">): string | null {
  if (!cfg.avatarId) return "Pick the avatar look (youtube_avatar_id) this channel presents as.";
  if (!cfg.voiceId) return "Pick the voice (youtube_voice_id) this channel speaks with.";
  return null;
}

export const SLIDE_LAYOUTS = ["title", "bullets", "compare", "flow", "statement", "code"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

type Side = { heading: string; rows: string[] };
export type VideoSlideSpec =
  | { layout: "title"; title: string; subtitle?: string | null }
  | { layout: "bullets"; title: string; rows: string[]; note?: string | null }
  | { layout: "compare"; title: string; left: Side; right: Side; note?: string | null }
  | { layout: "flow"; title: string; steps: string[]; note?: string | null }
  | { layout: "statement"; text: string; attribution?: string | null }
  | { layout: "code"; title: string; code: string; language?: string | null; note?: string | null }
  | { html: string };
/** What the viewer sees while a block plays: null films the avatar full-frame. */
export type VideoVisual = VideoSlideSpec | null;

/**
 * One slide entry as a model writes it: every field optional and nullable, so
 * one schema carries both modes and the models that send null for "unused".
 * parseVideoVisuals does the real validation and returns errors a model can
 * act on; a strict schema would only return a tool-call failure.
 */
export const VIDEO_SLIDE_INPUT_SCHEMA = z
  .object({
    layout: z.enum(["title", "bullets", "compare", "flow", "statement", "code"]).nullable().optional(),
    title: z.string().nullable().optional(),
    subtitle: z.string().nullable().optional(),
    rows: z.array(z.string()).nullable().optional(),
    note: z.string().nullable().optional(),
    left: z.object({ heading: z.string(), rows: z.array(z.string()) }).nullable().optional(),
    right: z.object({ heading: z.string(), rows: z.array(z.string()) }).nullable().optional(),
    steps: z.array(z.string()).nullable().optional(),
    text: z.string().nullable().optional(),
    attribution: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    html: z.string().nullable().optional(),
  })
  .nullable();

const SLIDE_HTML_MAX_CHARS = 12_000;
const SHORT = 90;

/** Parse one slide object, or say exactly what is wrong with it. */
function parseSlide(raw: Record<string, unknown>, where: string): { spec: VideoSlideSpec } | { error: string } {
  const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const lines = (v: unknown) => (Array.isArray(v) ? v.map(line).filter(Boolean) : []);
  const optional = (v: unknown) => line(v) || null;
  const tooLong = (label: string, values: string[], max: number) => {
    const bad = values.find((v) => v.length > max);
    return bad ? `${where}: ${label} "${bad.slice(0, 40)}…" is over ${max} chars; slides are read in a glance.` : null;
  };
  if (typeof raw.html === "string" && raw.html.trim()) {
    const html = raw.html.trim();
    if (html.length > SLIDE_HTML_MAX_CHARS) return { error: `${where}: html is over ${SLIDE_HTML_MAX_CHARS} chars.` };
    if (/<script/i.test(html)) return { error: `${where}: no <script>; the renderer runs with JavaScript off.` };
    if (/(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i.test(html)) {
      return { error: `${where}: no external images, fonts or links; draw with inline CSS or SVG.` };
    }
    return { spec: { html } };
  }
  // A layout-less {title, rows} outline predates the layouts: it is a bullets slide.
  const layout = raw.layout == null && Array.isArray(raw.rows) ? "bullets" : raw.layout;
  if (typeof layout !== "string" || !(SLIDE_LAYOUTS as readonly string[]).includes(layout)) {
    return { error: `${where}: layout must be one of ${SLIDE_LAYOUTS.join(", ")}.` };
  }
  const title = line(raw.title);
  if (layout !== "statement" && !title) return { error: `${where}: ${layout} needs a title.` };
  const titleIssue = tooLong("title", [title], SHORT);
  if (titleIssue) return { error: titleIssue };
  switch (layout) {
    case "title":
      return { spec: { layout, title, subtitle: optional(raw.subtitle) } };
    case "bullets": {
      const rows = lines(raw.rows);
      if (rows.length < 1 || rows.length > 6) return { error: `${where}: bullets needs 1-6 rows.` };
      const issue = tooLong("row", rows, SHORT);
      return issue ? { error: issue } : { spec: { layout, title, rows, note: optional(raw.note) } };
    }
    case "compare": {
      const side = (v: unknown): Side | null => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return null;
        const rec = v as Record<string, unknown>;
        const heading = line(rec.heading);
        return heading ? { heading, rows: lines(rec.rows).slice(0, 5) } : null;
      };
      const left = side(raw.left);
      const right = side(raw.right);
      if (!left || !right) return { error: `${where}: compare needs left and right, each {heading, rows}.` };
      const issue = tooLong("row", [left.heading, right.heading, ...left.rows, ...right.rows], 60);
      return issue ? { error: issue } : { spec: { layout, title, left, right, note: optional(raw.note) } };
    }
    case "flow": {
      const steps = lines(raw.steps);
      if (steps.length < 2 || steps.length > 5) return { error: `${where}: flow needs 2-5 steps.` };
      const issue = tooLong("step", steps, 40);
      return issue ? { error: issue } : { spec: { layout, title, steps, note: optional(raw.note) } };
    }
    case "statement": {
      const text = line(raw.text);
      if (!text) return { error: `${where}: statement needs text.` };
      const issue = tooLong("text", [text], 160);
      return issue ? { error: issue } : { spec: { layout, text, attribution: optional(raw.attribution) } };
    }
    case "code": {
      const code = typeof raw.code === "string" ? raw.code.replace(/\s+$/, "") : "";
      const codeLines = code.split("\n");
      if (!code.trim()) return { error: `${where}: code needs code.` };
      if (codeLines.length > 12) return { error: `${where}: code is ${codeLines.length} lines; show at most 12.` };
      const issue = tooLong("code line", codeLines, 80);
      return issue ? { error: issue } : { spec: { layout, title, code, language: optional(raw.language), note: optional(raw.note) } };
    }
  }
  return { error: `${where}: unknown layout.` };
}

/**
 * The stored visuals for a draft: content_meta.visuals holds one per block.
 * Drafts queued before visuals existed carry content_meta.slides, one outline
 * per body block with the first block always on camera; read those as that.
 */
export function storedVideoVisuals(meta: Record<string, unknown>, blockCount: number): unknown[] | null {
  if (Array.isArray(meta.visuals)) return meta.visuals.length === blockCount ? meta.visuals : null;
  if (Array.isArray(meta.slides)) return meta.slides.length === blockCount - 1 ? [null, ...meta.slides] : null;
  return null;
}

export function parseVideoVisuals(
  input: unknown,
  blockCount: number,
  mode: YoutubeSlideMode,
): { visuals: VideoVisual[]; issues: string[] } {
  const raw = Array.isArray(input) && input.length === blockCount ? input : null;
  if (!raw) {
    const got = Array.isArray(input) ? input.length : 0;
    return {
      visuals: [],
      issues: [`slides_mismatch: ${got} entries for ${blockCount} blocks. Give exactly one per block, in order: null for on camera, an object for a slide.`],
    };
  }
  const visuals: VideoVisual[] = [];
  const issues: string[] = [];
  raw.forEach((entry, i) => {
    const where = `slide_${i + 1}`;
    if (entry === null || entry === undefined) {
      visuals.push(null);
      return;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(`${where}: must be null (on camera) or a slide object.`);
      return;
    }
    const parsed = parseSlide(entry as Record<string, unknown>, where);
    if ("error" in parsed) {
      issues.push(parsed.error);
      return;
    }
    const isHtml = "html" in parsed.spec;
    if (mode === "html" && !isHtml) issues.push(`${where}: this channel designs its own slides; send {html}.`);
    else if (mode === "layouts" && isHtml) issues.push(`${where}: this channel uses layouts; send {layout, ...}, not html.`);
    else visuals.push(parsed.spec);
  });
  return { visuals, issues };
}

/** The part of the shift brief that teaches a persona to make its videos. */
export function buildYoutubeBrief(cfg: YoutubeChannelConfig, usage: VideoUsage | null): string {
  const targetWords = Math.round(cfg.targetMinutes * 60 * YOUTUBE_WORDS_PER_SECOND);
  const perMinute = Math.round(YOUTUBE_WORDS_PER_SECOND * 60);
  const slides =
    cfg.slideMode === "html"
      ? "A slide object is {html}: one self-contained HTML fragment with inline CSS or SVG that fills a 1920x1080 canvas. No scripts, no external images or fonts. You may use var(--bg) var(--fg) var(--muted) var(--accent) var(--hl) and the fonts var(--font) and var(--mono). Keep everything in the top 760px and out of the bottom-right 400x400 corner: captions and your bubble sit there."
      : "A slide object picks a layout: title {title, subtitle}, bullets {title, rows (1-6)}, compare {title, left {heading, rows}, right {heading, rows}}, flow {title, steps (2-5)}, statement {text}, code {title, code (≤12 lines)}. Read in a glance: titles and rows under 90 characters, compare rows under 60, flow steps under 40, a statement under 160.";
  const cost = estimateVideoCost(cfg.targetMinutes * 60);
  const budget = usage
    ? `Budget this week: ${usage.credits}/${cfg.weeklyBudgetCredits} credits and ${usage.videos}/${cfg.maxVideosPerWeek} videos used; a video like this costs ~${cost} credits.`
    : "";
  return [
    `YOUTUBE is a long-form talking video, never an article. Queue kind 'video' for platform 'youtube'. blocks = what you say out loud, ${YOUTUBE_MIN_BLOCKS}-${YOUTUBE_MAX_BLOCKS} blocks, ~${cfg.targetMinutes} minutes in total (≈${targetWords} words; you speak about ${perMinute} words a minute). slides = one entry per block, same order: null films you full-frame talking to camera, an object puts a slide on screen with you in a corner bubble. Open on camera with the hook, come back to camera for opinions and stories, use a slide when the viewer needs to see a list, a comparison, a flow or code.`,
    "Write for the ear: short sentences, contractions, talk to 'you', one concrete example or failure story per idea, say the opinion plainly. Never read the slide aloud; the slide shows the list, you say why it matters. No markdown, no URLs, no emoji. In blocks, say domains the way a person would ('agentwrotethis dot dev') and spell out acronyms a voice would mangle ('C I'); slides are read, not heard, so write them normally ('CI'). Pauses come from punctuation: end the sentence.",
    slides,
    "Build the video on one of your own published posts when you can, and pass its URL as canonical_url: it goes in the description as the full post.",
    cfg.direction ? `Direction for this channel from your operator: ${cfg.direction}` : "",
    budget,
  ]
    .filter(Boolean)
    .join(" ");
}
