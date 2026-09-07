/**
 * Per-channel backpressure. The rule that matters: a channel the persona fills
 * fast (X, 8/day) must never close the channels it fills slowly (blog, dev.to).
 * A single global buffer did exactly that in production — 58 queued tweets and
 * 18 days with no article, while both weekly article quotas sat BEHIND.
 */
import { describe, expect, it } from "vitest";

import { splitPlatformsByQueueRoom } from "../../lib/influencer/tick";
import type { PersonaChannel } from "../../lib/influencer/types";

function makeChannel(overrides: Partial<PersonaChannel> = {}): PersonaChannel {
  return {
    id: "c1",
    persona_id: "p1",
    platform: "x",
    external_handle: null,
    publish_via: "post_bridge",
    automation_level: "auto",
    max_posts_per_day: 8,
    max_replies_per_day: 8,
    credentials_ref: null,
    channel_config: {},
    onboarding: {},
    status: "active",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const x = makeChannel({ id: "x1", platform: "x", max_posts_per_day: 8 });
const devto = makeChannel({ id: "d1", platform: "devto", max_posts_per_day: 2 });
const blog = makeChannel({ id: "b1", platform: "blog", max_posts_per_day: 1 });

describe("splitPlatformsByQueueRoom", () => {
  it("keeps the slow channels open while the fast one is backed up", () => {
    const pending = new Map([["x1", 58]]);
    const { open, backedUp } = splitPlatformsByQueueRoom([x, devto, blog], pending);
    expect(open.sort()).toEqual(["blog", "devto"]);
    expect(backedUp).toEqual(["x"]);
  });

  it("opens every channel when nothing is queued", () => {
    const { open, backedUp } = splitPlatformsByQueueRoom([x, devto, blog], new Map());
    expect(open.sort()).toEqual(["blog", "devto", "x"]);
    expect(backedUp).toEqual([]);
  });

  it("closes a channel holding one full day of its own cap", () => {
    const pending = new Map([
      ["x1", 8],
      ["d1", 2],
      ["b1", 1],
    ]);
    const { open, backedUp } = splitPlatformsByQueueRoom([x, devto, blog], pending);
    expect(open).toEqual([]);
    expect(backedUp.sort()).toEqual(["blog", "devto", "x"]);
  });

  it("leaves a channel open one item below its cap", () => {
    const pending = new Map([
      ["x1", 7],
      ["d1", 1],
    ]);
    const { open } = splitPlatformsByQueueRoom([x, devto], pending);
    expect(open.sort()).toEqual(["devto", "x"]);
  });

  it("treats a platform as open when any of its channels has room", () => {
    const second = makeChannel({ id: "x2", platform: "x", max_posts_per_day: 8 });
    const pending = new Map([["x1", 8]]);
    const { open, backedUp } = splitPlatformsByQueueRoom([x, second], pending);
    expect(open).toEqual(["x"]);
    expect(backedUp).toEqual([]);
  });

  it("still allows one queued item on a channel capped at zero per day", () => {
    const paused = makeChannel({ id: "z1", platform: "blog", max_posts_per_day: 0 });
    const { open } = splitPlatformsByQueueRoom([paused], new Map());
    expect(open).toEqual(["blog"]);
    expect(splitPlatformsByQueueRoom([paused], new Map([["z1", 1]])).open).toEqual([]);
  });
});
