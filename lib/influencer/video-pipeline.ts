/**
 * Video pipeline: the stage machine for a youtube activity.
 *
 * approved (script blocks + visuals) → clips_ready (HeyGen mp4s) → ready
 * (finished mp4 attached by the worker) → published (YouTube, synthetic-media
 * flag set, visibility from the channel).
 *
 * Rendering burns real money, so every render passes the channel's weekly
 * budget first. Spend is tracked on the activities themselves, filed under
 * the ISO week it was burned (content_meta.render_spend) — no new table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createHeyGenVideo, getHeyGenVideo, resolveHeyGenKey } from "@/lib/influencer/heygen";
import { rowToActivity, updateActivity } from "@/lib/influencer/activities";
import {
  estimateSpeechSeconds,
  estimateVideoCost,
  parseVideoBlocks,
  parseVideoVisuals,
  storedVideoVisuals,
  validateVideoScript,
  weeklyLimitReason,
  youtubeChannelConfig,
  youtubeChannelReady,
  type VideoUsage,
  type VideoVisual,
  type YoutubeChannelConfig,
} from "@/lib/influencer/youtube";
import type { PersonaActivity, PersonaChannel } from "@/lib/influencer/types";

/**
 * The run did its job for now but must stop here by design (parked render
 * progress, composite waiting on a person). The publish cron counts these as
 * deferred, never failed.
 */
export class YoutubeDeferred extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "YoutubeDeferred";
  }
}

/** Deferred because the week's video budget or video count is spent. */
export class VideoBudgetDeferred extends YoutubeDeferred {
  constructor(reason: string) {
    super(reason);
    this.name = "VideoBudgetDeferred";
  }
}

export function weekStartUtcIso(now: Date): string {
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  return monday.toISOString();
}

/** The ISO week a credit was burned in, as its Monday: "2026-09-21". */
export function weekKey(now: Date): string {
  return weekStartUtcIso(now).slice(0, 10);
}

/** How far back a row can still be rendering: parked renders resume, drafts wait for review. */
const USAGE_LOOKBACK_DAYS = 35;

function spendByWeek(meta: Record<string, unknown>): Record<string, number> {
  const raw = meta.render_spend;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
    ),
  );
}

/**
 * What this channel's videos burned in the current ISO week, counted by the
 * week the credits were spent (content_meta.render_spend), not the week the
 * draft was queued: a render parked last week that resumes today spends
 * today's budget. Videos count by the week their render started.
 * `excludeActivityId` leaves one row out, so a render can price its own share.
 */
export async function videoUsageThisWeek(
  client: SupabaseClient,
  channelId: string,
  now: Date,
  excludeActivityId?: string,
): Promise<VideoUsage> {
  const since = new Date(Date.parse(weekStartUtcIso(now)) - USAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  let query = client
    .from("persona_activities")
    .select("content_meta")
    .eq("channel_id", channelId)
    .eq("kind", "video")
    .gte("created_at", since.toISOString());
  if (excludeActivityId) query = query.neq("id", excludeActivityId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const week = weekKey(now);
  let credits = 0;
  let videos = 0;
  for (const row of data ?? []) {
    const raw = (row as { content_meta?: unknown }).content_meta;
    const meta = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    credits += spendByWeek(meta)[week] ?? 0;
    if (meta.render_started_week === week) videos += 1;
  }
  return { credits: Math.round(credits * 100) / 100, videos };
}

export type RenderPlan = {
  blocks: string[];
  /** One per block: null films the avatar full-frame, a slide puts it in the bubble. */
  visuals: VideoVisual[];
  cfg: YoutubeChannelConfig;
  estimatedSeconds: number;
  estimatedCost: number;
};

/** Pure: what rendering this approved activity would cost. Throws when not renderable. */
export function planVideoRender(activity: PersonaActivity, channel: PersonaChannel): RenderPlan {
  const cfg = youtubeChannelConfig(channel);
  const missing = youtubeChannelReady(cfg);
  if (missing) throw new Error(missing);
  const blocks = resolveScriptBlocks(activity);
  const issues = validateVideoScript(blocks);
  if (issues.length) throw new Error(issues[0]);
  const stored = storedVideoVisuals(activity.content_meta, blocks!.length);
  if (!stored) {
    throw new Error(`slides_mismatch: the script has ${blocks!.length} blocks and the visuals do not pair one per block.`);
  }
  // Visuals are checked against the mode they were queued under, whatever the
  // channel says now: a mode switched after review must not strand the draft.
  const queuedMode = stored.some((v) => v && typeof v === "object" && "html" in v) ? "html" : "layouts";
  const { visuals, issues: visualIssues } = parseVideoVisuals(stored, blocks!.length, queuedMode);
  if (visualIssues.length) throw new Error(visualIssues[0]);
  const estimatedSeconds = estimateSpeechSeconds(blocks!);
  return { blocks: blocks!, visuals, cfg, estimatedSeconds, estimatedCost: estimateVideoCost(estimatedSeconds) };
}

/**
 * The queue's review edit writes activities.content, never content_meta.blocks
 * — so the reviewed text wins whenever it differs. But it wins loudly: an
 * edit that fails validation, or that no longer pairs one visual per block
 * (the worker refuses anything else and the paid clips would be wasted),
 * throws instead of silently filming stale blocks.
 */
export function resolveScriptBlocks(activity: PersonaActivity): string[] | null {
  const stored = parseVideoBlocks(activity.content_meta.blocks);
  const edited = typeof activity.content === "string" ? activity.content.trim() : "";
  if (edited) {
    const fromContent = edited
      .split(/\n\s*\n/)
      .map((b) => b.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const differs = !stored || fromContent.join("\n\n") !== stored.join("\n\n");
    if (fromContent.length > 1 && differs) {
      const hasVisuals = Array.isArray(activity.content_meta.visuals) || Array.isArray(activity.content_meta.slides);
      if (hasVisuals && !storedVideoVisuals(activity.content_meta, fromContent.length)) {
        throw new Error(
          `slides_mismatch: edited script has ${fromContent.length} blocks and the visuals no longer pair one per block. Keep the block count, or fix the visuals.`,
        );
      }
      const issues = validateVideoScript(fromContent);
      if (issues.length) throw new Error(issues[0]);
      return fromContent;
    }
  }
  return stored;
}

/**
 * Render every script block through HeyGen and park the clip URLs on the
 * activity. All blocks are submitted up front and polled together within one
 * short budget, then the run parks and the next one resumes from
 * heygen_video_ids — a render that holds the sequential publish loop hostage
 * starves every persona.
 * Spend accrues per completed block from HeyGen's real durations and is
 * persisted on every exit path, so the weekly budget always sees burned money.
 */
export async function renderVideoClips(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
  now: Date,
  // A preview renders a draft that stays a draft: parking must not reschedule
  // it into the publish queue.
  options: { keepStatus?: boolean } = {},
): Promise<{ videoUrls: string[]; renderCost: number }> {
  const plan = planVideoRender(activity, channel);
  // Positional by block: ids[i] and videoUrls[i] belong to block i, and a null
  // is a block not submitted or not finished yet. One array for the whole run:
  // re-deriving from the claim-time snapshot would erase an id persisted
  // minutes ago, and HeyGen would bill that block again next run.
  const positional = (raw: unknown) =>
    plan.blocks.map((_, i) => {
      const v = Array.isArray(raw) ? raw[i] : null;
      return typeof v === "string" && v.length > 0 ? v : null;
    });
  const ids = positional(activity.content_meta.heygen_video_ids);
  const videoUrls = positional(activity.content_meta.video_urls);
  // Cost already burned by earlier runs of this same render (persisted on
  // every park): resumed blocks don't re-bill, but they did bill once.
  const priorCost =
    typeof activity.content_meta.render_cost === "number" &&
    Number.isFinite(activity.content_meta.render_cost) &&
    activity.content_meta.render_cost > 0
      ? activity.content_meta.render_cost
      : 0;
  const week = weekKey(now);
  const priorSpend = spendByWeek(activity.content_meta);
  // This row's share of the week: what it already burned this week plus what
  // is left of its plan. The others are counted apart, so a resume never pays
  // twice for its own blocks, and a render resumed in a new week only asks
  // the new week for what remains.
  const usage = await videoUsageThisWeek(client, activity.channel_id, now, activity.id);
  const share = Math.round(((priorSpend[week] ?? 0) + Math.max(0, plan.estimatedCost - priorCost)) * 100) / 100;
  const limit = weeklyLimitReason(usage, share, plan.cfg, !ids.some(Boolean));
  if (limit) {
    // Park until the week rolls over, releasing the cron's claim: failing
    // would strand clips already paid for on a resumed render.
    if (!options.keepStatus) {
      const nextWeek = new Date(Date.parse(weekStartUtcIso(now)) + 7 * 24 * 60 * 60 * 1000);
      await updateActivity(client, activity.id, {
        status: "scheduled",
        scheduled_at: nextWeek.toISOString(),
      });
    }
    throw new VideoBudgetDeferred(`${limit} This render waits for next week.`);
  }
  const apiKey = await resolveHeyGenKey(client, activity.persona_id);
  let burnSeconds = 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  // Total for the row, and the same money filed under the week it was spent.
  const spent = () => ({
    render_cost: round(priorCost + estimateVideoCost(burnSeconds)),
    render_spend: { ...priorSpend, [week]: round((priorSpend[week] ?? 0) + estimateVideoCost(burnSeconds)) },
  });
  const startedWeek =
    typeof activity.content_meta.render_started_week === "string" ? activity.content_meta.render_started_week : week;
  const persistPartial = () =>
    updateActivity(client, activity.id, {
      ...(options.keepStatus
        ? {}
        : { status: "scheduled" as const, scheduled_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString() }),
      content_meta: {
        ...activity.content_meta,
        heygen_video_ids: ids,
        video_urls: videoUrls,
        render_started_week: startedWeek,
        ...spent(),
      },
    });
  // Submit every block first, so HeyGen renders them side by side. One at a
  // time, a 12-block video would advance one clip per cron run.
  for (let i = 0; i < plan.blocks.length; i += 1) {
    if (ids[i] || videoUrls[i]) continue;
    try {
      ids[i] = await createHeyGenVideo(apiKey, {
        avatarId: plan.cfg.avatarId!,
        script: plan.blocks[i],
        voiceId: plan.cfg.voiceId!,
        // On-camera blocks keep the avatar's setting (full frame); slide
        // blocks come back on a matte the compositor crops into the bubble.
        removeBackground: plan.visuals[i] !== null,
        resolution: plan.cfg.resolution,
        expressiveness: plan.cfg.expressiveness,
        motionPrompt: plan.cfg.motionPrompt,
        voiceSpeed: plan.cfg.voiceSpeed,
        title: `${activity.title ?? "persona video"} block ${i + 1}`,
      });
    } catch (err) {
      // HeyGen caps concurrent renders per plan: over the cap is a wait, not a failure.
      if (err instanceof Error && /HTTP 429/.test(err.message)) {
        await persistPartial();
        throw new YoutubeDeferred(`HeyGen is at its concurrency limit after ${ids.filter(Boolean).length} of ${ids.length} blocks; submitting the rest next run.`);
      }
      throw err;
    }
    // Persisted as each one is created: a crash here must not re-bill a block.
    await updateActivity(client, activity.id, {
      content_meta: { ...activity.content_meta, heygen_video_ids: ids, video_urls: videoUrls, render_started_week: startedWeek },
    });
  }
  // One look round per run: finished clips land by index, anything still
  // cooking parks for the next run instead of holding the publish loop.
  const deadline = Date.now() + 45 * 1000;
  for (;;) {
    for (let i = 0; i < plan.blocks.length; i += 1) {
      if (videoUrls[i]) continue;
      const job = await getHeyGenVideo(apiKey, ids[i]!);
      if (job.status === "completed" && job.videoUrl) {
        videoUrls[i] = job.videoUrl;
        burnSeconds += job.durationSeconds ?? estimateSpeechSeconds([plan.blocks[i]]);
      } else if (job.status === "failed") {
        // Free the slot: a retry must submit this block again, not re-read
        // the same failed job forever.
        ids[i] = null;
        await persistPartial();
        throw new Error(`HeyGen block ${i + 1} failed: ${job.failureMessage ?? "unknown"}. Fix the script and retry.`);
      }
    }
    const done = videoUrls.filter(Boolean).length;
    if (done === plan.blocks.length) break;
    if (Date.now() > deadline) {
      await persistPartial();
      throw new YoutubeDeferred(`${done} of ${plan.blocks.length} HeyGen clips ready; parked progress and retrying next run.`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const clips = videoUrls as string[]; // every slot filled: the loop above only breaks when done
  const final = spent();
  await updateActivity(client, activity.id, {
    content_meta: {
      ...activity.content_meta,
      heygen_video_ids: ids,
      video_urls: clips,
      render_started_week: startedWeek,
      ...final,
      stage: "clips_ready",
    },
  });
  return { videoUrls: clips, renderCost: final.render_cost };
}

const PREVIEWS_PER_RUN = 2;

/** Merge keys into an activity's content_meta on a fresh read, not a snapshot. */
async function mergeContentMeta(client: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await client.from("persona_activities").select("content_meta").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  const current = (data?.content_meta ?? {}) as Record<string, unknown>;
  await updateActivity(client, id, { content_meta: { ...current, ...patch } });
}

/**
 * Drafts someone asked to see as a finished video ("Render preview"). Renders
 * the avatar clips the same way an approved video does, spending the same
 * weekly budget, but the draft stays a draft: the worker composites it and it
 * comes back to the review queue to be watched. Nothing here publishes. A
 * failure or a spent budget is written on the draft and the request cleared,
 * so the next run does not retry what a person has to fix.
 */
export async function renderRequestedPreviews(
  client: SupabaseClient,
  now: Date,
  channelById: Map<string, PersonaChannel>,
): Promise<number> {
  // Only the rows that asked, oldest first, a few per run: each render may
  // hold the run for its poll budget, and the publish loop waits behind it.
  const { data, error } = await client
    .from("persona_activities")
    .select("*")
    .eq("kind", "video")
    .eq("status", "draft")
    .contains("content_meta", { render_requested: true })
    .order("created_at", { ascending: true })
    .limit(PREVIEWS_PER_RUN * 5);
  if (error) throw new Error(error.message);
  let handled = 0;
  for (const row of data ?? []) {
    // Only rows handed to HeyGen count against the run's budget: a skipped
    // one must never hold a slot a waiting draft could use.
    if (handled >= PREVIEWS_PER_RUN) break;
    const activity = rowToActivity(row as Record<string, unknown>);
    const meta = activity.content_meta;
    if (meta.render_requested !== true || meta.stage === "clips_ready" || meta.final_url) continue;
    const channel = channelById.get(activity.channel_id);
    if (!channel) continue;
    handled += 1;
    let clipsReady = false;
    try {
      await renderVideoClips(client, activity, channel, now, { keepStatus: true });
      clipsReady = true;
    } catch (err) {
      if (err instanceof YoutubeDeferred && !(err instanceof VideoBudgetDeferred)) continue; // still rendering
      await mergeContentMeta(client, activity.id, {
        render_requested: false,
        render_error: err instanceof Error ? err.message : String(err),
      });
    }
    // Clips done: the worker takes it from here, and clearing the request
    // frees the slot. A failure of this bookkeeping is not a render failure,
    // so it is logged, never written on the draft.
    if (clipsReady) {
      try {
        await mergeContentMeta(client, activity.id, { render_requested: false });
      } catch (err) {
        console.error("[influencer] could not clear render_requested:", err instanceof Error ? err.message : "unknown error");
      }
    }
  }
  return handled;
}
