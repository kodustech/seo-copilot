/**
 * Per-channel backpressure. The rule that matters: a channel the persona fills
 * fast (X, 8/day) must never close the channels it fills slowly (blog, dev.to).
 * A single global buffer did exactly that in production — 58 queued tweets and
 * 18 days with no article, while both weekly article quotas sat BEHIND.
 */
import { afterEach, describe, expect, it } from "vitest";

import { pickChannel } from "../../lib/influencer/agent";
import { isActionable, splitPlatformsByQueueRoom } from "../../lib/influencer/tick";
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

  it("judges a platform by its first channel, not by a free sibling", () => {
    // Opening the platform because a sibling is free would need a policy for
    // which channel the draft lands on — and that policy decides whether a
    // piece skips a review gate. One channel decides, in one place.
    const second = makeChannel({ id: "x2", platform: "x", max_posts_per_day: 8 });
    const pending = new Map([["x1", 8]]);
    const { open, backedUp, openChannelIds } = splitPlatformsByQueueRoom([x, second], pending);
    expect(open).toEqual([]);
    expect(backedUp).toEqual(["x"]);
    expect(openChannelIds).toEqual([]);
  });

  it("names the channel each draft will land on", () => {
    // The tool needs the id, not just the platform: without it the writer picks
    // for itself and can write past a channel's buffer.
    const second = makeChannel({ id: "x2", platform: "x", max_posts_per_day: 8 });
    const { openChannelIds } = splitPlatformsByQueueRoom([x, second], new Map());
    expect(openChannelIds).toEqual(["x1"]);
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

  it("writes to the channel the caller named", () => {
    expect(pickChannel([oldest, sibling], "x", ["x1"])?.id).toBe("x1");
  });

  it("returns nothing when that channel has no room", () => {
    // Handing back a full channel would write past its buffer — one draft a
    // shift, which is the arithmetic that grew the queue to 58.
    expect(pickChannel([oldest, sibling], "x", [])).toBeUndefined();
  });

  it("carries no policy of its own about which sibling to use", () => {
    // splitPlatformsByQueueRoom names one channel per platform, so there is
    // never a second candidate here to silently choose between.
    const gated = makeChannel({ id: "g1", platform: "x", automation_level: "approve_first" });
    expect(pickChannel([gated, sibling], "x", ["x2"])?.id).toBe("x2");
    expect(pickChannel([gated, sibling], "x", ["g1"])?.id).toBe("g1");
  });

  it("behaves as before when the caller names no open channels", () => {
    expect(pickChannel([oldest, sibling], "x")?.id).toBe("x1");
  });

  it("falls back to a paused channel only when nothing is active", () => {
    const paused = makeChannel({ id: "x9", platform: "x", status: "paused" });
    expect(pickChannel([paused], "x")?.id).toBe("x9");
  });
});

describe("isActionable, for a blog channel", () => {
  const blogChannel = (credentials_ref: string | null) =>
    makeChannel({ platform: "blog", publish_via: "api", credentials_ref, max_posts_per_day: 1 });

  afterEach(() => {
    delete process.env.CONTENT_API_KEY;
    delete process.env.CONTENT_API_KEY_BENCH;
  });

  it("asks the same question the publisher will ask", () => {
    process.env.CONTENT_API_KEY_BENCH = "key";
    expect(isActionable(blogChannel("CONTENT_API_KEY_BENCH"))).toBe(true);
  });

  it("understands the sentinel the connect flow writes", () => {
    // The live channel carries credentials_ref "env:content_api", which names
    // no env var. Reading it as one silences every UI-connected blog channel.
    process.env.CONTENT_API_KEY = "key";
    expect(isActionable(blogChannel("env:content_api"))).toBe(true);
  });

  it("refuses a credentials_ref that is not a content key name", () => {
    // The publisher rejects these, so accepting them here buys wasted shifts.
    process.env.DATABASE_URL = "postgres://somewhere";
    process.env.CONTENT_API_KEY = "key";
    expect(isActionable(blogChannel("DATABASE_URL"))).toBe(false);
    delete process.env.DATABASE_URL;
  });

  it("refuses the sentinel when the shared key is missing", () => {
    expect(isActionable(blogChannel("env:content_api"))).toBe(false);
  });

  it("refuses a channel naming a key that was never deployed", () => {
    // Accepting it would spend shifts writing for a site whose publish then
    // throws at cron time, every time.
    process.env.CONTENT_API_KEY = "the default site's key";
    expect(isActionable(blogChannel("CONTENT_API_KEY_BENCH"))).toBe(false);
  });

  it("falls back to the shared key when the channel names none", () => {
    process.env.CONTENT_API_KEY = "key";
    expect(isActionable(blogChannel(null))).toBe(true);
  });

  it("is not actionable with no key at all", () => {
    expect(isActionable(blogChannel(null))).toBe(false);
  });
});
