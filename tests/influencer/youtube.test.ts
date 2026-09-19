/**
 * YouTube channel rules: a video that costs real money and discloses AI use
 * must be gated before it renders, not after it spends.
 */
import { describe, expect, it } from "vitest";

import { channelDefaults } from "../../lib/influencer/types";
import {
  buildVideoDescription,
  estimateVideoCost,
  parseVideoBlocks,
  validateVideoScript,
  withinWeeklyCap,
  youtubeChannelConfig,
  youtubeChannelReady,
  YOUTUBE_MAX_BLOCKS,
  YOUTUBE_WEEKLY_CAP_CREDITS,
} from "../../lib/influencer/youtube";
import { buildCompositePlan, compositePlanSeconds } from "../../lib/influencer/video-composite";
import { buildHeyGenVideoBody } from "../../lib/influencer/heygen";
import { buildYoutubeVideoMetadata } from "../../lib/influencer/youtube-upload";
import { planVideoRender } from "../../lib/influencer/video-pipeline";

describe("youtube channel defaults", () => {
  it("publishes one video a day through the API, never auto", () => {
    const d = channelDefaults("youtube");
    expect(d.publish_via).toBe("api");
    expect(d.automation_level).toBe("approve_first");
    expect(d.max_posts_per_day).toBe(1);
    expect(d.max_replies_per_day).toBe(0);
  });
});

describe("validateVideoScript", () => {
  const good = ["First spoken thought here.", "Second spoken thought here.", "Third spoken thought here."];
  it("accepts 3-8 spoken blocks", () => {
    expect(validateVideoScript(good)).toEqual([]);
  });
  it("refuses articles and junk", () => {
    expect(validateVideoScript(null)).toHaveLength(1);
    expect(validateVideoScript("a whole article")).toHaveLength(1);
    expect(validateVideoScript([])).toHaveLength(1);
  });
  it("refuses too many, too short, too long", () => {
    const many = Array.from({ length: YOUTUBE_MAX_BLOCKS + 1 }, (_, i) => `Spoken block number ${i} with enough words.`);
    expect(validateVideoScript(many).join()).toMatch(/too_many_blocks/);
    expect(validateVideoScript(["ok block with words here", "x"]).join()).toMatch(/too_short/);
    expect(validateVideoScript([`ok block with words here and more`, "y".repeat(601)]).join()).toMatch(/too_long/);
  });
  it("parseVideoBlocks trims and drops empties", () => {
    expect(parseVideoBlocks(["  hello  ", "", 42, "world"])).toEqual(["hello", "world"]);
  });
});

describe("video money gate", () => {
  it("estimates from the measured rate", () => {
    // CSV 2026-09-19: 19s cost 0.73 credits.
    expect(estimateVideoCost(19)).toBeCloseTo(0.76, 1);
    expect(estimateVideoCost(0)).toBe(0);
  });
  it("holds the weekly cap", () => {
    expect(withinWeeklyCap(0, 5)).toBe(true);
    expect(withinWeeklyCap(YOUTUBE_WEEKLY_CAP_CREDITS, 0.01)).toBe(false);
  });
});

describe("youtube channel config", () => {
  it("reads avatar + voice off the channel", () => {
    const cfg = youtubeChannelConfig({
      channel_config: { youtube_avatar_id: "lk_1", youtube_voice_id: "v1", youtube_site_url: "https://agentwrotethis.dev" },
    });
    expect(cfg.avatarId).toBe("lk_1");
    expect(youtubeChannelReady(cfg)).toBeNull();
  });
  it("names what is missing", () => {
    expect(youtubeChannelReady(youtubeChannelConfig({ channel_config: {} }))).toMatch(/avatar/);
  });
});

describe("buildVideoDescription", () => {
  it("leads with the AI note and links the original", () => {
    const d = buildVideoDescription({
      canonicalUrl: "https://agentwrotethis.dev/posts/x",
      musicCredit: "Acoustic by Y (CC-BY)",
      siteUrl: "https://agentwrotethis.dev",
    });
    expect(d).toMatch(/AI-generated/);
    expect(d).toMatch(/Full post: https:\/\/agentwrotethis.dev\/posts\/x/);
    expect(d).toMatch(/Music: /);
  });
});

describe("planVideoRender", () => {
  const channel = {
    id: "ch",
    persona_id: "p",
    platform: "youtube",
    external_handle: null,
    publish_via: "api",
    automation_level: "approve_first",
    max_posts_per_day: 1,
    max_replies_per_day: 0,
    credentials_ref: "vault:youtube",
    channel_config: { youtube_avatar_id: "lk_1", youtube_voice_id: "v1" },
    onboarding: {},
    status: "active",
    created_at: "",
    updated_at: "",
  } as Parameters<typeof planVideoRender>[1];
  const activity = {
    id: "a",
    persona_id: "p",
    channel_id: "ch",
    kind: "video",
    status: "approved",
    title: "Test video",
    content: "spoken script",
    content_meta: { blocks: ["First spoken thought here.", "Second spoken thought here."] },
    source_kind: null,
    source_ref: null,
    parent_activity_id: null,
    scheduled_at: null,
    published_at: null,
    external_id: null,
    external_url: null,
    error: null,
    approved_by: null,
    created_at: "",
    updated_at: "",
  } as Parameters<typeof planVideoRender>[0];
  it("prices the render before it runs", () => {
    const plan = planVideoRender(activity, channel);
    expect(plan.avatarId).toBe("lk_1");
    expect(plan.blocks).toHaveLength(2);
    expect(plan.estimatedCost).toBeGreaterThan(0);
  });
  it("refuses without avatar + voice", () => {
    const bare = { ...channel, channel_config: {} };
    expect(() => planVideoRender(activity, bare)).toThrow(/avatar/);
  });
  it("refuses a bad script", () => {
    const bad = { ...activity, content_meta: { blocks: ["x"] } };
    expect(() => planVideoRender(bad, channel)).toThrow(/too_short/);
  });
});

describe("buildHeyGenVideoBody", () => {
  it("sends script + voice, white matte for the bubble", () => {
    const body = buildHeyGenVideoBody({ avatarId: "lk_1", script: "Hello there.", voiceId: "v1", removeBackground: true });
    expect(body).toMatchObject({ type: "avatar", avatar_id: "lk_1", script: "Hello there.", voice_id: "v1", remove_background: true });
  });
  it("accepts external narration instead of TTS", () => {
    const body = buildHeyGenVideoBody({ avatarId: "lk_1", audioAssetId: "a1" });
    expect(body).toMatchObject({ audio_asset_id: "a1" });
    expect(body).not.toHaveProperty("script");
  });
  it("refuses zero or two audio sources", () => {
    expect(() => buildHeyGenVideoBody({ avatarId: "lk_1" })).toThrow(/exactly one audio source/);
    expect(() =>
      buildHeyGenVideoBody({ avatarId: "lk_1", script: "Hi.", audioAssetId: "a1" }),
    ).toThrow(/exactly one audio source/);
  });
});

describe("buildYoutubeVideoMetadata", () => {
  it("is always unlisted — no public path exists", () => {
    const meta = buildYoutubeVideoMetadata({ title: "Hello", description: "AI-generated." }) as {
      status: { privacyStatus: string };
    };
    expect(meta.status.privacyStatus).toBe("unlisted");
  });
  it("requires a title", () => {
    expect(() => buildYoutubeVideoMetadata({ title: "  ", description: "x" })).toThrow(/title is required/);
  });
});

describe("buildCompositePlan", () => {
  const slides = [{ png: "s2.png", avatarMp4: "b2.mp4", seconds: 19 }];
  it("needs an intro and at least one slide", () => {
    expect(() =>
      buildCompositePlan({ introAvatarMp4: "", introSeconds: 17, slides, outputMp4: "o.mp4" }),
    ).toThrow(/intro/);
    expect(() =>
      buildCompositePlan({ introAvatarMp4: "i.mp4", introSeconds: 17, slides: [], outputMp4: "o.mp4" }),
    ).toThrow(/at least one slide/);
  });
  it("caps the music bed below the voice", () => {
    expect(() =>
      buildCompositePlan({ introAvatarMp4: "i.mp4", introSeconds: 17, slides, outputMp4: "o.mp4", musicLevel: 0.9 }),
    ).toThrow(/musicLevel/);
  });
  it("sums runtime", () => {
    const plan = buildCompositePlan({ introAvatarMp4: "i.mp4", introSeconds: 17, slides, outputMp4: "o.mp4" });
    expect(compositePlanSeconds(plan)).toBe(36);
  });
});
