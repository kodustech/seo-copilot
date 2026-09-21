/**
 * Video pipeline: the stage machine for a youtube activity.
 *
 * approved (script blocks + visuals) → clips_ready (HeyGen mp4s) → ready
 * (finished mp4 attached by the worker) → published (YouTube, synthetic-media
 * flag set, visibility from the channel).
 *
 * Rendering burns real money, so every render passes the channel's weekly
 * budget first. Spend is tracked on the activities themselves
 * (content_meta.render_cost), summed per channel per ISO week — no new table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createHeyGenVideo, getHeyGenVideo, resolveHeyGenKey } from "@/lib/influencer/heygen";
import { updateActivity } from "@/lib/influencer/activities";
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

export function weekStartUtcIso(now: Date): string {
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  return monday.toISOString();
}

/**
 * What this channel's videos burned since Monday 00:00 UTC: credits, and how
 * many videos started rendering. `excludeActivityId` leaves one row out: a
 * resumed render prices its own full plan, so its persisted render_cost must
 * not be counted a second time.
 */
export async function videoUsageThisWeek(
  client: SupabaseClient,
  channelId: string,
  now: Date,
  excludeActivityId?: string,
): Promise<VideoUsage> {
  let query = client
    .from("persona_activities")
    .select("content_meta")
    .eq("channel_id", channelId)
    .eq("kind", "video")
    .gte("created_at", weekStartUtcIso(now));
  if (excludeActivityId) query = query.neq("id", excludeActivityId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  let credits = 0;
  let videos = 0;
  for (const row of data ?? []) {
    const raw = (row as { content_meta?: unknown }).content_meta;
    const meta = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const cost = meta.render_cost;
    const burned = typeof cost === "number" && Number.isFinite(cost) && cost > 0;
    if (burned) credits += cost;
    const started = Array.isArray(meta.heygen_video_ids) && meta.heygen_video_ids.length > 0;
    if (burned || started) videos += 1;
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
 * activity. Never sleeps past the cron's budget: one poll round per block,
 * then park and let the next run resume from heygen_video_ids — a render
 * that holds the sequential publish loop hostage starves every persona.
 * Spend accrues per completed block from HeyGen's real durations and is
 * persisted on every exit path, so the weekly budget always sees burned money.
 */
export async function renderVideoClips(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
  now: Date,
): Promise<{ videoUrls: string[]; renderCost: number }> {
  const plan = planVideoRender(activity, channel);
  // One id array for the whole run: re-deriving from the claim-time snapshot
  // would erase the id persisted for a block created minutes ago and HeyGen
  // would bill the same block again on the next run.
  const ids: string[] = Array.isArray(activity.content_meta.heygen_video_ids)
    ? (activity.content_meta.heygen_video_ids as unknown[]).filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  // The full-plan estimate already covers this row's earlier runs, so count
  // every other video only — counting this row too would refuse a resume
  // that fits.
  const usage = await videoUsageThisWeek(client, activity.channel_id, now, activity.id);
  const limit = weeklyLimitReason(usage, plan.estimatedCost, plan.cfg, ids.length === 0);
  if (limit) {
    // Park until the week rolls over, releasing the cron's claim: failing
    // would strand clips already paid for on a resumed render.
    const nextWeek = new Date(Date.parse(weekStartUtcIso(now)) + 7 * 24 * 60 * 60 * 1000);
    await updateActivity(client, activity.id, {
      status: "scheduled",
      scheduled_at: nextWeek.toISOString(),
    });
    throw new YoutubeDeferred(`${limit} This render waits for next week.`);
  }
  const apiKey = await resolveHeyGenKey(client, activity.persona_id);
  const prior = Array.isArray(activity.content_meta.video_urls)
    ? (activity.content_meta.video_urls as unknown[]).filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      )
    : [];
  const videoUrls = [...prior];
  // Cost already burned by earlier runs of this same render (persisted on
  // every park): the cap prices cumulative HeyGen spend, never a per-run
  // fresh count — resumed blocks don't re-bill, but they did bill once.
  const priorCost =
    typeof activity.content_meta.render_cost === "number" &&
    Number.isFinite(activity.content_meta.render_cost) &&
    activity.content_meta.render_cost > 0
      ? activity.content_meta.render_cost
      : 0;
  let burnSeconds = 0;
  const runCost = () => Math.round((priorCost + estimateVideoCost(burnSeconds)) * 100) / 100;
  const persistPartial = (stage?: string) =>
    updateActivity(client, activity.id, {
      status: "scheduled",
      scheduled_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      content_meta: {
        ...activity.content_meta,
        heygen_video_ids: ids,
        video_urls: videoUrls.filter(Boolean),
        render_cost: runCost(),
        ...(stage ? { stage } : {}),
      },
    });
  for (let i = prior.length; i < plan.blocks.length; i += 1) {
    let videoId = ids[i];
    if (!videoId) {
      videoId = await createHeyGenVideo(apiKey, {
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
      ids[i] = videoId;
      await updateActivity(client, activity.id, {
        content_meta: { ...activity.content_meta, heygen_video_ids: ids },
      });
    }
    // One look per run: completed clips resume by id, anything still cooking
    // parks for the next run instead of sleeping inside the publish loop.
    const deadline = Date.now() + 45 * 1000;
    for (;;) {
      const job = await getHeyGenVideo(apiKey, videoId);
      if (job.status === "completed" && job.videoUrl) {
        videoUrls[i] = job.videoUrl;
        burnSeconds += job.durationSeconds ?? 20;
        break;
      }
      if (job.status === "failed") {
        await persistPartial();
        throw new Error(`HeyGen block ${i + 1} failed: ${job.failureMessage ?? "unknown"}. Fix the script and retry.`);
      }
      if (Date.now() > deadline) {
        // Park progress; the next run resumes from heygen_video_ids.
        await persistPartial();
        throw new YoutubeDeferred(`HeyGen block ${i + 1} still rendering; parked progress and retrying next run.`);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  const renderCost = runCost();
  await updateActivity(client, activity.id, {
    content_meta: {
      ...activity.content_meta,
      video_urls: videoUrls,
      render_cost: renderCost,
      stage: "clips_ready",
    },
  });
  return { videoUrls, renderCost };
}
