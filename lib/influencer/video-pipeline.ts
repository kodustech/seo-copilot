/**
 * Video pipeline: the stage machine for a youtube activity.
 *
 * approved (script blocks) → clips_ready (HeyGen mp4s) → ready (finished mp4
 * attached by scripts/render-video-from-plan.py) → published (YouTube,
 * unlisted, awaiting the human's AI-checkbox).
 *
 * Rendering burns real money, so every render passes the weekly cap first.
 * Spend is tracked on the activities themselves (content_meta.render_cost),
 * summed per persona per ISO week — no new table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createHeyGenVideo, getHeyGenVideo, resolveHeyGenKey } from "@/lib/influencer/heygen";
import { updateActivity } from "@/lib/influencer/activities";
import {
  estimateVideoCost,
  parseVideoBlocks,
  validateVideoScript,
  withinWeeklyCap,
  youtubeChannelConfig,
  youtubeChannelReady,
  YOUTUBE_WEEKLY_CAP_CREDITS,
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

/** Credits already burned by this persona's videos since Monday 00:00 UTC. */
export async function sumVideoSpendThisWeek(
  client: SupabaseClient,
  personaId: string,
  now: Date,
): Promise<number> {
  const { data, error } = await client
    .from("persona_activities")
    .select("content_meta")
    .eq("persona_id", personaId)
    .eq("kind", "video")
    .gte("created_at", weekStartUtcIso(now));
  if (error) throw new Error(error.message);
  let sum = 0;
  for (const row of data ?? []) {
    const meta = (row as { content_meta?: unknown }).content_meta;
    const cost =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).render_cost
        : null;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) sum += cost;
  }
  return Math.round(sum * 100) / 100;
}

export type RenderPlan = {
  blocks: string[];
  avatarId: string;
  voiceId: string;
  /** First block renders full-frame (intro); the rest background-free (bubble). */
  estimatedSeconds: number;
  estimatedCost: number;
};

/** Pure: what rendering this approved activity would cost. Throws when not renderable. */
export function planVideoRender(
  activity: PersonaActivity,
  channel: PersonaChannel,
  avgSecondsPerBlock = 20,
): RenderPlan {
  const cfg = youtubeChannelConfig(channel);
  const missing = youtubeChannelReady(cfg);
  if (missing) throw new Error(missing);
  const blocks = parseVideoBlocks(activity.content_meta.blocks);
  const issues = validateVideoScript(blocks);
  if (issues.length) throw new Error(issues[0]);
  const estimatedSeconds = blocks!.length * avgSecondsPerBlock;
  return {
    blocks: blocks!,
    avatarId: cfg.avatarId!,
    voiceId: cfg.voiceId!,
    estimatedSeconds,
    estimatedCost: estimateVideoCost(estimatedSeconds),
  };
}

/**
 * Render every script block through HeyGen and park the clip URLs on the
 * activity. Polls inline (blocks are ~15-25s each); the cron's 60s budget
 * fits one short video per run — longer ones finish across runs because
 * completed blocks are skipped by id.
 */
export async function renderVideoClips(
  client: SupabaseClient,
  activity: PersonaActivity,
  channel: PersonaChannel,
  now: Date,
): Promise<{ videoUrls: string[]; renderCost: number }> {
  const plan = planVideoRender(activity, channel);
  const spent = await sumVideoSpendThisWeek(client, activity.persona_id, now);
  if (!withinWeeklyCap(spent, plan.estimatedCost)) {
    throw new Error(
      `Weekly video cap reached (${spent}/${YOUTUBE_WEEKLY_CAP_CREDITS} credits). This render (~${plan.estimatedCost}) waits for next week.`,
    );
  }
  const apiKey = await resolveHeyGenKey(client, activity.persona_id);
  const prior = Array.isArray(activity.content_meta.video_urls)
    ? (activity.content_meta.video_urls as unknown[]).filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      )
    : [];
  const videoUrls = [...prior];
  for (let i = prior.length; i < plan.blocks.length; i += 1) {
    const ids = Array.isArray(activity.content_meta.heygen_video_ids)
      ? (activity.content_meta.heygen_video_ids as unknown[]).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [];
    let videoId = ids[i];
    if (!videoId) {
      videoId = await createHeyGenVideo(apiKey, {
        avatarId: plan.avatarId,
        script: plan.blocks[i],
        voiceId: plan.voiceId,
        // Intro keeps its setting (full frame); body blocks come back on a
        // white matte the compositor turns into the bubble.
        removeBackground: i > 0,
        title: `${activity.title ?? "persona video"} bloco ${i + 1}`,
      });
      ids[i] = videoId;
      await updateActivity(client, activity.id, {
        content_meta: { ...activity.content_meta, heygen_video_ids: ids },
      });
    }
    const deadline = Date.now() + 4 * 60 * 1000;
    for (;;) {
      const job = await getHeyGenVideo(apiKey, videoId);
      if (job.status === "completed" && job.videoUrl) {
        videoUrls[i] = job.videoUrl;
        break;
      }
      if (job.status === "failed") {
        throw new Error(`HeyGen block ${i + 1} failed: ${job.failureMessage ?? "unknown"}. Fix the script and retry.`);
      }
      if (Date.now() > deadline) {
        // Park progress; the next cron run resumes from heygen_video_ids.
        await updateActivity(client, activity.id, {
          status: "scheduled",
          scheduled_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
          content_meta: { ...activity.content_meta, heygen_video_ids: ids, video_urls: videoUrls.filter(Boolean) },
        });
        throw new YoutubeDeferred(`HeyGen block ${i + 1} still rendering; parked progress and retrying next run.`);
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  const renderCost = estimateVideoCost(
    plan.blocks.length * 20,
  );
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
