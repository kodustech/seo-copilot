/**
 * Revising a post instead of publishing a second one next to it. The site is
 * git-backed and refuses an existing slug unless overwrite says so, so a
 * revision is the same call carrying the slug it replaces.
 */
import { describe, expect, it } from "vitest";

import { resolveBlogSourceBase } from "../../lib/influencer/publish";
import type { PersonaChannel } from "../../lib/influencer/types";

function makeChannel(channel_config: Record<string, unknown>): PersonaChannel {
  return {
    id: "b1",
    persona_id: "p1",
    platform: "blog",
    external_handle: null,
    publish_via: "api",
    automation_level: "auto",
    max_posts_per_day: 1,
    max_replies_per_day: 0,
    credentials_ref: null,
    channel_config,
    onboarding: {},
    status: "active",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

describe("resolveBlogSourceBase", () => {
  it("returns the configured base without its trailing slash", () => {
    const base = "https://raw.githubusercontent.com/kodustech/aicodereview.io/main/src/content/blog";
    expect(resolveBlogSourceBase(makeChannel({ blog_source_base: `${base}//` }))).toBe(base);
  });

  it("is null when the channel names none, so read_post says so instead of guessing", () => {
    // The path convention belongs to the site's repo; deriving it from the API
    // URL would work for one site and quietly 404 for the next.
    expect(resolveBlogSourceBase(makeChannel({}))).toBeNull();
    expect(resolveBlogSourceBase(makeChannel({ blog_source_base: "   " }))).toBeNull();
    expect(resolveBlogSourceBase(makeChannel({ blog_source_base: 42 }))).toBeNull();
  });
});
