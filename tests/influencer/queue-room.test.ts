/**
 * Per-channel backpressure. The rule that matters: a channel the persona fills
 * fast (X, 8/day) must never close the channels it fills slowly (blog, dev.to).
 * A single global buffer did exactly that in production — 58 queued tweets and
 * 18 days with no article, while both weekly article quotas sat BEHIND.
 */
import { describe, expect, it } from "vitest";

import { pickChannel } from "../../lib/influencer/agent";
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

  it("names the channel with room, not just its platform", () => {
    // The draft lands on ONE channel. Reporting only "x is open" would send
    // every draft to the oldest channel of that platform — the full one — and
    // reproduce the queue drift one level down.
    const second = makeChannel({ id: "x2", platform: "x", max_posts_per_day: 8 });
    const pending = new Map([["x1", 8]]);
    const { openChannelIds } = splitPlatformsByQueueRoom([x, second], pending);
    expect(openChannelIds).toEqual(["x2"]);
  });

  it("lists every channel with room across platforms", () => {
    const { openChannelIds } = splitPlatformsByQueueRoom(
      [x, devto, blog],
      new Map([["d1", 2]]),
    );
    expect(openChannelIds).toEqual(["x1", "b1"]);
  });

  it("still allows one queued item on a channel capped at zero per day", () => {
    const paused = makeChannel({ id: "z1", platform: "blog", max_posts_per_day: 0 });
    const { open } = splitPlatformsByQueueRoom([paused], new Map());
    expect(open).toEqual(["blog"]);
    expect(splitPlatformsByQueueRoom([paused], new Map([["z1", 1]])).open).toEqual([]);
  });
});

describe("pickChannel", () => {
  const oldest = makeChannel({ id: "x1", platform: "x", automation_level: "auto" });
  const sibling = makeChannel({ id: "x2", platform: "x", automation_level: "auto" });

  it("keeps the oldest channel when it has room", () => {
    expect(pickChannel([oldest, sibling], "x", ["x1", "x2"])?.id).toBe("x1");
  });

  it("deflects to a sibling with room when the oldest is full", () => {
    expect(pickChannel([oldest, sibling], "x", ["x2"])?.id).toBe("x2");
  });

  it("will not deflect across automation levels", () => {
    // An auto channel publishes on its own and an approve_first one waits for a
    // human. Crossing that line silently puts the post on a cadence nobody chose.
    const needsReview = makeChannel({ id: "x3", platform: "x", automation_level: "approve_first" });
    expect(pickChannel([oldest, needsReview], "x", ["x3"])).toBeUndefined();
  });

  it("returns nothing rather than a channel without room", () => {
    // Handing back the full oldest channel would write past its buffer — one
    // draft a shift, which is the arithmetic that grew the queue to 58.
    expect(pickChannel([oldest, sibling], "x", [])).toBeUndefined();
    expect(pickChannel([oldest, sibling], "x", ["other-platform-id"])).toBeUndefined();
  });

  it("behaves as before when the caller names no open channels", () => {
    expect(pickChannel([oldest, sibling], "x")?.id).toBe("x1");
  });

  it("falls back to a paused channel only when the caller names no open ones", () => {
    const paused = makeChannel({ id: "x9", platform: "x", status: "paused" });
    expect(pickChannel([paused], "x")?.id).toBe("x9");
  });
});
