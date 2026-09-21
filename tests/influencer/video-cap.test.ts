/**
 * Weekly limits on a render: the row's own burned credits are already inside
 * its full-plan estimate, so they must not be counted twice; the video limit
 * only stops renders that have not started; a blocked render parks for next
 * week instead of failing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/influencer/activities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/influencer/activities")>()),
  updateActivity: vi.fn(),
}));
vi.mock("@/lib/influencer/heygen", () => ({
  createHeyGenVideo: vi.fn(async () => "new-id"),
  getHeyGenVideo: vi.fn(async () => ({ status: "completed", videoUrl: "https://clip/3.mp4", durationSeconds: 20 })),
  resolveHeyGenKey: vi.fn(async () => "key"),
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { updateActivity } from "../../lib/influencer/activities";
import { createHeyGenVideo, getHeyGenVideo } from "../../lib/influencer/heygen";
import {
  renderRequestedPreviews,
  renderVideoClips,
  VideoBudgetDeferred,
  videoUsageThisWeek,
  YoutubeDeferred,
} from "../../lib/influencer/video-pipeline";

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
      render_spend: { "2026-09-21": 9 },
    });
    const client = fakeClient([
      { id: "a", content_meta: { render_cost: 9, render_spend: { "2026-09-21": 9 } } },
      { id: "other", content_meta: { render_spend: { "2026-09-21": 1 } } },
    ]);
    // Counting its own 9 credits twice: 19 > 10.1. Once, as its share: 10.
    const out = await renderVideoClips(client, resumed, channelWith({ youtube_weekly_budget_credits: 10.1 }), now);
    expect(out.videoUrls).toHaveLength(3);
  });

  it("parks for next Monday when the credit budget blocks", async () => {
    const client = fakeClient([{ id: "other", content_meta: { render_spend: { "2026-09-21": 11 } } }]);
    const channel = channelWith({ youtube_weekly_budget_credits: 11.1, youtube_max_videos_per_week: 5 });
    await expect(renderVideoClips(client, activity({}), channel, now)).rejects.toThrow(/budget reached/);
    expect(updateActivity).toHaveBeenCalledWith(client, "a", nextMonday);
  });

  it("parks a fresh render when the week's videos are used, but lets a started one finish", async () => {
    const client = fakeClient([{ id: "other", content_meta: { render_started_week: "2026-09-21" } }]);
    const channel = channelWith({ youtube_max_videos_per_week: 1 });
    await expect(renderVideoClips(client, activity({}), channel, now)).rejects.toBeInstanceOf(YoutubeDeferred);
    expect(updateActivity).toHaveBeenCalledWith(client, "a", nextMonday);
    const started = activity({ video_urls: ["https://clip/1.mp4", "https://clip/2.mp4"], heygen_video_ids: ["id1", "id2"] });
    const out = await renderVideoClips(client, started, channel, now);
    expect(out.videoUrls).toHaveLength(3);
  });
});

describe("spend by the week it was burned", () => {
  beforeEach(() => vi.mocked(updateActivity).mockReset());

  it("counts only this week's share of each row", async () => {
    const client = fakeClient([
      { id: "old", content_meta: { render_spend: { "2026-09-14": 5, "2026-09-21": 2 }, render_started_week: "2026-09-14" } },
      { id: "new", content_meta: { render_spend: { "2026-09-21": 3 }, render_started_week: "2026-09-21" } },
    ]);
    expect(await videoUsageThisWeek(client, "ch", now)).toEqual({ credits: 5, videos: 1 });
  });

  it("files what a render parked last week burns today under this week", async () => {
    const resumed = activity({
      video_urls: ["https://clip/1.mp4", "https://clip/2.mp4"],
      heygen_video_ids: ["id1", "id2"],
      render_cost: 9,
      render_spend: { "2026-09-14": 9 },
      render_started_week: "2026-09-14",
    });
    // Last week's 9 credits are not this week's: only what remains of the plan is asked of it.
    await renderVideoClips(fakeClient([]), resumed, channelWith({ youtube_weekly_budget_credits: 3 }), now);
    const meta = vi.mocked(updateActivity).mock.calls.at(-1)![2].content_meta as Record<string, unknown>;
    // Block 3 came back 20s long: 0.8 credits, spent this week.
    expect(meta.render_spend).toEqual({ "2026-09-14": 9, "2026-09-21": 0.8 });
    expect(meta.render_cost).toBe(9.8);
    expect(meta.render_started_week).toBe("2026-09-14");
  });
});

describe("renderVideoClips in parallel", () => {
  const done = (id: string) => ({
    videoId: id,
    status: "completed" as const,
    videoUrl: `https://clip/${id}.mp4`,
    durationSeconds: 4,
    failureMessage: null,
  });
  const lastMeta = () => vi.mocked(updateActivity).mock.calls.at(-1)![2].content_meta as Record<string, unknown>;
  const channel = channelWith({ youtube_max_videos_per_week: 5 });
  beforeEach(() => vi.mocked(updateActivity).mockReset());
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(createHeyGenVideo).mockImplementation(async () => "new-id");
    vi.mocked(getHeyGenVideo).mockImplementation(async () => done("3"));
  });

  it("submits every block before polling, and parks with each clip in its block's slot", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.mocked(createHeyGenVideo).mockImplementation(async (_key, req) => {
      calls.push(`create ${req.title}`);
      return `id-${calls.length}`;
    });
    vi.mocked(getHeyGenVideo).mockImplementation(async (_key, id) => {
      calls.push(`poll ${id}`);
      return id === "id-2" ? { ...done(id), status: "processing", videoUrl: null } : done(id);
    });
    const run = expect(renderVideoClips(fakeClient([]), activity({}), channel, now)).rejects.toThrow(/2 of 3 HeyGen clips ready/);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(calls.slice(0, 3)).toEqual(["create Test video block 1", "create Test video block 2", "create Test video block 3"]);
    expect(lastMeta()).toMatchObject({
      heygen_video_ids: ["id-1", "id-2", "id-3"],
      video_urls: ["https://clip/id-1.mp4", null, "https://clip/id-3.mp4"],
    });
  });

  it("waits when HeyGen is at its concurrency limit, keeping the ids it got", async () => {
    let n = 0;
    vi.mocked(createHeyGenVideo).mockImplementation(async () => {
      n += 1;
      if (n === 3) throw new Error("HeyGen /v3/videos HTTP 429: too many concurrent renders");
      return `id-${n}`;
    });
    await expect(renderVideoClips(fakeClient([]), activity({}), channel, now)).rejects.toBeInstanceOf(YoutubeDeferred);
    expect(lastMeta()).toMatchObject({ heygen_video_ids: ["id-1", "id-2", null] });
  });

  it("finishes with every clip in order and the ids kept", async () => {
    let n = 0;
    vi.mocked(createHeyGenVideo).mockImplementation(async () => `id-${(n += 1)}`);
    vi.mocked(getHeyGenVideo).mockImplementation(async (_key, id) => done(id));
    const out = await renderVideoClips(fakeClient([]), activity({}), channel, now);
    expect(out.videoUrls).toEqual(["https://clip/id-1.mp4", "https://clip/id-2.mp4", "https://clip/id-3.mp4"]);
    expect(lastMeta()).toMatchObject({ stage: "clips_ready", heygen_video_ids: ["id-1", "id-2", "id-3"] });
  });
});

describe("preview renders", () => {
  beforeEach(() => vi.mocked(updateActivity).mockReset());

  /** Drafts to scan, plus the usage query and the fresh read the pass makes. */
  function previewClient(rows: Record<string, unknown>[]): SupabaseClient {
    const query = () => {
      const filters: Record<string, unknown> = {};
      const b = {
        select: () => b,
        eq: (col: string, v: unknown) => ((filters[col] = v), b),
        gte: () => b,
        neq: () => b,
        order: () => b,
        limit: () => b,
        contains: (_col: string, v: Record<string, unknown>) => ((filters.contains = v), b),
        maybeSingle: () => Promise.resolve({ data: rows.find((r) => r.id === filters.id) ?? null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data:
              filters.status === "draft"
                ? rows.filter(
                    (r) =>
                      r.status === "draft" &&
                      (!filters.contains || (r.content_meta as Record<string, unknown>).render_requested === true),
                  )
                : [],
            error: null,
          }),
      };
      return b;
    };
    return { from: query } as unknown as SupabaseClient;
  }
  const draftRow = (id: string, meta: Record<string, unknown>) => ({
    id,
    persona_id: "p",
    channel_id: "ch",
    kind: "video",
    status: "draft",
    title: "Test video",
    content: "spoken script",
    content_meta: {
      blocks: ["First spoken thought here.", "Second spoken thought here.", "Third spoken thought here."],
      visuals: [null, { layout: "bullets", title: "Two", rows: ["a"] }, null],
      test_run: true,
      ...meta,
    },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  it("renders a requested preview and leaves the draft a draft", async () => {
    const channels = new Map([["ch", channelWith({ youtube_max_videos_per_week: 5 })]]);
    const handled = await renderRequestedPreviews(
      previewClient([draftRow("a", { render_requested: true }), draftRow("b", {})]),
      now,
      channels,
    );
    expect(handled).toBe(1);
    const patches = vi.mocked(updateActivity).mock.calls.map((c) => c[2] as Record<string, unknown>);
    expect(patches.every((p) => !("status" in p))).toBe(true);
    expect(patches.some((p) => (p.content_meta as Record<string, unknown>)?.stage === "clips_ready")).toBe(true);
    // Clips done, request cleared: the slot goes to drafts still waiting on HeyGen.
    expect(patches.at(-1)!.content_meta).toMatchObject({ render_requested: false });
  });

  it("writes a spent budget on the draft instead of retrying it every run", async () => {
    const channels = new Map([["ch", channelWith({ youtube_max_videos_per_week: 0 })]]);
    await renderRequestedPreviews(previewClient([draftRow("a", { render_requested: true })]), now, channels);
    const last = vi.mocked(updateActivity).mock.calls.at(-1)![2] as { status?: string; content_meta: Record<string, unknown> };
    expect(last.status).toBeUndefined();
    expect(last.content_meta).toMatchObject({ render_requested: false, render_error: expect.stringMatching(/video limit/) });
  });

  it("parks a capped approved render for next week, but only reports it for a preview", async () => {
    const channel = channelWith({ youtube_max_videos_per_week: 0 });
    await expect(renderVideoClips(fakeClient([]), activity({}), channel, now, { keepStatus: true })).rejects.toBeInstanceOf(
      VideoBudgetDeferred,
    );
    expect(updateActivity).not.toHaveBeenCalled();
  });
});
