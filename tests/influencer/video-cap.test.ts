/**
 * Weekly limits on a render: the row's own burned credits are already inside
 * its full-plan estimate, so they must not be counted twice; the video limit
 * only stops renders that have not started; a blocked render parks for next
 * week instead of failing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/influencer/activities", () => ({ updateActivity: vi.fn() }));
vi.mock("@/lib/influencer/heygen", () => ({
  createHeyGenVideo: vi.fn(async () => "new-id"),
  getHeyGenVideo: vi.fn(async () => ({ status: "completed", videoUrl: "https://clip/3.mp4", durationSeconds: 20 })),
  resolveHeyGenKey: vi.fn(async () => "key"),
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { updateActivity } from "../../lib/influencer/activities";
import { renderVideoClips, YoutubeDeferred } from "../../lib/influencer/video-pipeline";

type Row = { id: string; content_meta: Record<string, unknown> };

/** Just enough of the query builder for sumVideoSpendThisWeek. */
function fakeClient(rows: Row[]): SupabaseClient {
  let excluded: string | null = null;
  const builder = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    neq: (_col: string, id: string) => {
      excluded = id;
      return builder;
    },
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows.filter((r) => r.id !== excluded), error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

function channelWith(limits: Record<string, unknown>) {
  return {
    id: "ch",
    persona_id: "p",
    platform: "youtube",
    channel_config: { youtube_avatar_id: "lk_1", youtube_voice_id: "v1", ...limits },
  } as unknown as Parameters<typeof renderVideoClips>[2];
}

function activity(meta: Record<string, unknown>) {
  return {
    id: "a",
    persona_id: "p",
    channel_id: "ch",
    kind: "video",
    status: "publishing",
    title: "Test video",
    content: "spoken script",
    content_meta: {
      blocks: ["First spoken thought here.", "Second spoken thought here.", "Third spoken thought here."],
      visuals: [null, { layout: "bullets", title: "Two", rows: ["a"] }, null],
      ...meta,
    },
  } as unknown as Parameters<typeof renderVideoClips>[1];
}

// Monday 2026-09-21 is the week start. The script is 12 words: ~4s, 0.16 credits.
const now = new Date("2026-09-23T12:00:00Z");
const nextMonday = { status: "scheduled", scheduled_at: "2026-09-28T00:00:00.000Z" };

describe("renderVideoClips weekly limits", () => {
  beforeEach(() => vi.mocked(updateActivity).mockReset());

  it("resumes a render whose own burned cost would have tipped the sum over", async () => {
    const resumed = activity({
      video_urls: ["https://clip/1.mp4", "https://clip/2.mp4"],
      heygen_video_ids: ["id1", "id2"],
      render_cost: 9,
    });
    const client = fakeClient([
      { id: "a", content_meta: { render_cost: 9 } },
      { id: "other", content_meta: { render_cost: 1 } },
    ]);
    // Counting its own 9 credits: 10.16 > 10.1. Without them: 1.16.
    const out = await renderVideoClips(client, resumed, channelWith({ youtube_weekly_budget_credits: 10.1 }), now);
    expect(out.videoUrls).toHaveLength(3);
  });

  it("parks for next Monday when the credit budget blocks", async () => {
    const client = fakeClient([{ id: "other", content_meta: { render_cost: 11 } }]);
    const channel = channelWith({ youtube_weekly_budget_credits: 11.1, youtube_max_videos_per_week: 5 });
    await expect(renderVideoClips(client, activity({}), channel, now)).rejects.toThrow(/budget reached/);
    expect(updateActivity).toHaveBeenCalledWith(client, "a", nextMonday);
  });

  it("parks a fresh render when the week's videos are used, but lets a started one finish", async () => {
    const client = fakeClient([{ id: "other", content_meta: { heygen_video_ids: ["x"] } }]);
    const channel = channelWith({ youtube_max_videos_per_week: 1 });
    await expect(renderVideoClips(client, activity({}), channel, now)).rejects.toBeInstanceOf(YoutubeDeferred);
    expect(updateActivity).toHaveBeenCalledWith(client, "a", nextMonday);
    const started = activity({ video_urls: ["https://clip/1.mp4", "https://clip/2.mp4"], heygen_video_ids: ["id1", "id2"] });
    const out = await renderVideoClips(client, started, channel, now);
    expect(out.videoUrls).toHaveLength(3);
  });
});
