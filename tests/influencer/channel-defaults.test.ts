/**
 * How a channel is born. The bug this covers was not a crash: the wizard seeded
 * six channels and left out the blog, so a persona created to write a farm site
 * had no blog channel at all, and the persona page offers no way to add one.
 * It surfaced only when someone went to connect the site and the row was not
 * there.
 */
import { describe, expect, it } from "vitest";

import { CHANNEL_PLATFORMS, channelDefaults } from "../../lib/influencer/types";

describe("channelDefaults", () => {
  it("covers every platform the fleet knows about", () => {
    // A platform added to the union without a default here is a channel that
    // gets created with undefined caps.
    for (const platform of CHANNEL_PLATFORMS) {
      const d = channelDefaults(platform);
      expect(d.publish_via, platform).toBeTruthy();
      expect(d.automation_level, platform).toBeTruthy();
      expect(Number.isInteger(d.max_posts_per_day), platform).toBe(true);
      expect(Number.isInteger(d.max_replies_per_day), platform).toBe(true);
    }
  });

  it("gives the blog the shape the publisher actually uses", () => {
    const d = channelDefaults("blog");
    // publishActivity dispatches on platform before reading publish_via, so
    // this value is metadata; it still has to say what happens, which is the
    // site's own content API and not the n8n path it used to claim.
    expect(d.publish_via).toBe("api");
    expect(d.max_posts_per_day).toBe(1);
    // A blog has nothing to reply to.
    expect(d.max_replies_per_day).toBe(0);
  });

  it("never births a channel that publishes without a human", () => {
    // Autonomy is earned per channel after setup, never granted at creation.
    for (const platform of CHANNEL_PLATFORMS) {
      expect(channelDefaults(platform).automation_level, platform).not.toBe("auto");
    }
  });

  it("keeps hand-posted platforms draft-only", () => {
    for (const platform of ["reddit", "hackernews", "hackernoon"] as const) {
      const d = channelDefaults(platform);
      expect(d.publish_via, platform).toBe("manual");
      expect(d.automation_level, platform).toBe("draft_only");
    }
  });

  it("routes the two that publish by themselves to their own adapters", () => {
    expect(channelDefaults("x").publish_via).toBe("post_bridge");
    expect(channelDefaults("devto").publish_via).toBe("api");
    // Medium has no API since 2023; the browser drives "Import a story".
    expect(channelDefaults("medium").publish_via).toBe("browser");
  });
});
