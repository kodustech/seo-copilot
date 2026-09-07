/**
 * The alert for a channel that has quietly stopped. A persona saturating one
 * channel looks healthy from every angle — busy shifts, a full feed — while a
 * channel with a quota sits at zero. That is how the blog went 18 days without
 * an article with nobody noticing.
 */
import { describe, expect, it } from "vitest";

import { silentChannels, type GoalProgress } from "../../lib/influencer/goals";

const MONDAY = new Date("2026-09-07T09:00:00.000Z"); // week just started
const THURSDAY = new Date("2026-09-10T18:00:00.000Z"); // past halfway

function goal(overrides: Partial<GoalProgress> = {}): GoalProgress {
  return {
    type: "posts_per_week",
    channel: "blog",
    target: 2,
    label: "Post 2x a week on the blog",
    current: 0,
    onTrack: false,
    detail: "0/2 published this week on blog",
    ...overrides,
  };
}

describe("silentChannels", () => {
  it("stays quiet early in the week, when zero just means it's Monday", () => {
    expect(silentChannels([goal()], MONDAY)).toEqual([]);
  });

  it("reports a channel still at zero once the week is half gone", () => {
    expect(silentChannels([goal()], THURSDAY)).toEqual([{ channel: "blog", target: 2 }]);
  });

  it("says nothing about a channel that has published", () => {
    expect(silentChannels([goal({ current: 1 })], THURSDAY)).toEqual([]);
  });

  it("only judges goals with a weekly quota", () => {
    const followers = goal({ type: "followers", channel: undefined, current: 0 });
    const qualitative = goal({ type: "custom", channel: undefined, current: null });
    expect(silentChannels([followers, qualitative], THURSDAY)).toEqual([]);
  });

  it("reports every silent channel, not just the first", () => {
    const result = silentChannels([goal(), goal({ channel: "devto", target: 2 })], THURSDAY);
    expect(result.map((r) => r.channel)).toEqual(["blog", "devto"]);
  });
});
