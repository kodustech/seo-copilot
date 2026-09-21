/**
 * Weekly cap on a resumed render: the row's own burned credits are already
 * inside its full-plan estimate, so they must not be counted twice — and a
 * render the cap does block parks for next week instead of failing.
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

const channel = {
  id: "ch",
  persona_id: "p",
  platform: "youtube",
  channel_config: { youtube_avatar_id: "lk_1", youtube_voice_id: "v1" },
} as unknown as Parameters<typeof renderVideoClips>[2];

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
      ...meta,
    },
  } as unknown as Parameters<typeof renderVideoClips>[1];
}

// Monday 2026-09-21 is the week start; the plan is 3 blocks (~2.4 credits).
const now = new Date("2026-09-23T12:00:00Z");

describe("renderVideoClips weekly cap", () => {
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
    const out = await renderVideoClips(client, resumed, channel, now);
    expect(out.videoUrls).toHaveLength(3);
  });

  it("parks for next Monday instead of failing when the cap blocks", async () => {
    const client = fakeClient([{ id: "other", content_meta: { render_cost: 11 } }]);
    await expect(renderVideoClips(client, activity({}), channel, now)).rejects.toBeInstanceOf(YoutubeDeferred);
    expect(updateActivity).toHaveBeenCalledWith(client, "a", {
      status: "scheduled",
      scheduled_at: "2026-09-28T00:00:00.000Z",
    });
  });
});
