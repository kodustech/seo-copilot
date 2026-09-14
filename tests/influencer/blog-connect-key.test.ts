/**
 * Connecting is also how a connected channel's taxonomy gets edited, so a save
 * that carries no key has to be allowed — but only on a channel that already
 * keeps one, and only while it stays on the same site. The key is found by the
 * vault marker, not by host, so a request that repointed the channel and
 * skipped the key check would send one site's writer credential to whatever
 * host it named.
 */
import { describe, expect, it } from "vitest";

import {
  CONTENT_KEY_SENTINEL,
  CONTENT_KEY_VAULT,
  DEFAULT_BLOG_API_URL,
  blogConnectNeedsKey,
  blogDestination,
} from "../../lib/influencer/publish";

const FARM = "https://mergerequests.dev";

const channel = (credentials_ref: string | null, blog_api_url?: string) => ({
  credentials_ref,
  channel_config: blog_api_url ? { blog_api_url } : {},
});

/** What the route asks: the destination this request would leave behind. */
const destinationFor = (ch: ReturnType<typeof channel>, requested = "") =>
  blogDestination(ch, requested);

describe("blogConnectNeedsKey", () => {
  it("lets a farm channel save its taxonomy without resending the key", () => {
    const ch = channel(CONTENT_KEY_VAULT, FARM);
    expect(blogConnectNeedsKey(ch, destinationFor(ch))).toBe(false);
  });

  it("accepts a per-site env ref as a key of its own", () => {
    // The env path predates the vault and publish.ts keeps it supported; a
    // channel on it was hitting the 400 the taxonomy edit exists to remove.
    const ch = channel("CONTENT_API_KEY_MERGEREQUESTS", FARM);
    expect(blogConnectNeedsKey(ch, destinationFor(ch))).toBe(false);
  });

  it("demands a key when the same request repoints the channel elsewhere", () => {
    // The hole: no key, vault marker kept, host swapped — and the next publish
    // would POST this site's key to the new host.
    const ch = channel(CONTENT_KEY_VAULT, FARM);
    expect(blogConnectNeedsKey(ch, destinationFor(ch, "https://somewhere-else.example"))).toBe(
      true,
    );
    // Same site written differently is not a move.
    expect(blogConnectNeedsKey(ch, destinationFor(ch, "https://www.mergerequests.dev/"))).toBe(
      false,
    );
  });

  it("never lets the shared key stand in for a site's own", () => {
    // The sentinel means "the workspace key", which only publishes to the
    // default site — it is not a key this channel holds.
    const ch = channel(CONTENT_KEY_SENTINEL, FARM);
    expect(blogConnectNeedsKey(ch, destinationFor(ch))).toBe(true);
  });

  it("does not mistake the shared key, named outright, for one of its own", () => {
    // contentEnvNameFor groups a bare CONTENT_API_KEY with the sentinel: it is
    // the shared key by another name, and it publishes to the default site
    // alone. A gate that read it as a per-site key would report a farm channel
    // connected and leave it publishing nowhere.
    const farm = channel("CONTENT_API_KEY", FARM);
    expect(blogConnectNeedsKey(farm, destinationFor(farm))).toBe(true);
    const home = channel("CONTENT_API_KEY", DEFAULT_BLOG_API_URL);
    expect(blogConnectNeedsKey(home, destinationFor(home))).toBe(true);
  });

  it("still demands one from a channel that holds nothing", () => {
    const ch = channel(null, FARM);
    expect(blogConnectNeedsKey(ch, destinationFor(ch))).toBe(true);
  });

  it("asks the default site's channel for one too, so the route judges the shared key", () => {
    const ch = channel(CONTENT_KEY_SENTINEL, DEFAULT_BLOG_API_URL);
    expect(blogConnectNeedsKey(ch, destinationFor(ch))).toBe(true);
  });
});
