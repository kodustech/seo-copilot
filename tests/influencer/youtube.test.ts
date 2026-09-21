/**
 * YouTube channel rules: a video that costs real money and discloses AI use
 * must be gated before it renders, not after it spends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { channelDefaults } from "../../lib/influencer/types";
import {
  buildVideoDescription,
  buildYoutubeBrief,
  estimateVideoCost,
  parseVideoBlocks,
  parseVideoVisuals,
  storedVideoVisuals,
  validateVideoLength,
  validateVideoScript,
  validateVideoVoice,
  weeklyLimitReason,
  youtubeChannelConfig,
  youtubeChannelReady,
  YOUTUBE_MAX_BLOCK_CHARS,
  YOUTUBE_MAX_BLOCKS,
} from "../../lib/influencer/youtube";
import { createYoutubeOAuthState, nonceMatches, parseYoutubeOAuthState } from "../../lib/influencer/youtube-oauth";
import { buildCompositePlan, compositePlanSeconds } from "../../lib/influencer/video-composite";
import { buildHeyGenVideoBody } from "../../lib/influencer/heygen";
import { buildYoutubeVideoMetadata } from "../../lib/influencer/youtube-upload";
import { planVideoRender, resolveScriptBlocks } from "../../lib/influencer/video-pipeline";

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
  it("refuses too few, too many, too short, too long", () => {
    expect(validateVideoScript(["Only one spoken thought here."]).join()).toMatch(/too_few_blocks/);
    expect(validateVideoScript(["First thought here.", "Second thought here."]).join()).toMatch(/too_few_blocks/);
    const many = Array.from({ length: YOUTUBE_MAX_BLOCKS + 1 }, (_, i) => `Spoken block number ${i} with enough words.`);
    expect(validateVideoScript(many).join()).toMatch(/too_many_blocks/);
    expect(validateVideoScript(["ok block with words here", "x"]).join()).toMatch(/too_short/);
    expect(validateVideoScript([`ok block with words here and more`, "y".repeat(YOUTUBE_MAX_BLOCK_CHARS + 1)]).join()).toMatch(/too_long/);
  });
  it("refuses what a voice would read aloud as noise", () => {
    const withMarkup = ["First spoken thought here.", "- a bullet, not a sentence", "Third spoken thought here."];
    expect(validateVideoScript(withMarkup).join()).toMatch(/block_2_markup/);
    const withUrl = ["First spoken thought here.", "Read it at https://agentwrotethis.dev today.", "Third spoken thought here."];
    expect(validateVideoScript(withUrl).join()).toMatch(/block_2_url/);
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
  const limits = { weeklyBudgetCredits: 12, maxVideosPerWeek: 1 };
  it("holds the channel's weekly budget", () => {
    expect(weeklyLimitReason({ credits: 0, videos: 0 }, 10.8, limits, true)).toBeNull();
    expect(weeklyLimitReason({ credits: 2, videos: 0 }, 10.8, limits, true)).toMatch(/budget/);
  });
  it("counts videos only for a render that has not started", () => {
    expect(weeklyLimitReason({ credits: 0, videos: 1 }, 5, limits, true)).toMatch(/video limit/);
    // A parked render resumes even when the week's video slot is taken.
    expect(weeklyLimitReason({ credits: 0, videos: 1 }, 5, limits, false)).toBeNull();
    expect(weeklyLimitReason({ credits: 0, videos: 0 }, 5, { ...limits, maxVideosPerWeek: 0 }, true)).toMatch(/video limit/);
  });
});

describe("validateVideoVoice", () => {
  // Lines from a real test draft (2026-09-21) that read as generated.
  const generated = [
    "The gap is not what the AI knows about your project. It is what the AI is told to do with that knowledge.",
    "Review instructions should live in the repository, not a wiki page.",
    "Here is the line worth stealing from that piece. The standard runs every time.",
    "Here is the deeper shift, and it is worth sitting with. The review becomes the first real look.",
    "Buy the encoding, not the review tool.",
  ];
  it("flags stacked contrasts and announcements, quoting where they are", () => {
    const issues = validateVideoVoice(generated).join("\n");
    expect(issues).toMatch(/sounds_generated_contrast: 3/);
    expect(issues).toMatch(/block 1: "not what the AI knows/);
    expect(issues).toMatch(/sounds_generated_signposts/);
  });
  it("lets one of each through, the way a person talks", () => {
    expect(
      validateVideoVoice([
        "The question isn't whether you have a harness, it's which part you own.",
        "Here's my take: start from one rule you already enforce.",
        "Write it as a config file and review it in a pull request like any code.",
      ]),
    ).toEqual([]);
  });
});

describe("validateVideoLength", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  it("accepts a script around the target", () => {
    // 4.5 min at 2.9 words/s is ~783 words.
    expect(validateVideoLength([words(260), words(260), words(260)], 4.5)).toEqual([]);
  });
  it("says how far off a short or long script is", () => {
    expect(validateVideoLength([words(100), words(100), words(100)], 4.5).join()).toMatch(/video_too_short.*≈783 words/);
    expect(validateVideoLength([words(400), words(400), words(400)], 4.5).join()).toMatch(/video_too_long/);
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
  it("defaults to public, layouts, 4.5 min and the default budget", () => {
    const cfg = youtubeChannelConfig({ channel_config: {} });
    expect(cfg).toMatchObject({
      privacy: "public",
      slideMode: "layouts",
      targetMinutes: 4.5,
      weeklyBudgetCredits: 12,
      maxVideosPerWeek: 1,
      expressiveness: null,
      resolution: "720p",
    });
  });
  it("reads the form's string values and drops junk", () => {
    const cfg = youtubeChannelConfig({
      channel_config: {
        youtube_privacy: " Unlisted ",
        youtube_target_minutes: "5",
        youtube_weekly_budget_credits: "30",
        youtube_max_videos_per_week: "0",
        youtube_voice_speed: "9",
        youtube_expressiveness: "off",
        youtube_slide_mode: "html",
      },
    });
    expect(cfg).toMatchObject({
      privacy: "unlisted",
      targetMinutes: 5,
      weeklyBudgetCredits: 30,
      maxVideosPerWeek: 0,
      voiceSpeed: null,
      expressiveness: null,
      slideMode: "html",
    });
  });
});

describe("buildYoutubeBrief", () => {
  const cfg = youtubeChannelConfig({ channel_config: { youtube_direction: "Expand your posts on review load." } });
  it("carries the target, the direction and the budget", () => {
    const brief = buildYoutubeBrief(cfg, { credits: 3, videos: 0 });
    expect(brief).toMatch(/~4.5 minutes/);
    expect(brief).toMatch(/Expand your posts on review load/);
    expect(brief).toMatch(/3\/12 credits and 0\/1 videos/);
    expect(brief).toMatch(/layout/);
  });
  it("ties one block to one screen", () => {
    expect(buildYoutubeBrief(cfg, null)).toMatch(/one block per screen/);
    expect(buildYoutubeBrief(cfg, null)).toMatch(/15 to 30 seconds/);
  });
  it("asks for its own example, one named source and real code on screen", () => {
    const brief = buildYoutubeBrief(cfg, null);
    expect(brief).toMatch(/name its author/);
    expect(brief).toMatch(/Never invent an anecdote/);
    expect(brief).toMatch(/at least one code slide/);
  });
  it("teaches the html mode its canvas and safe area", () => {
    const brief = buildYoutubeBrief({ ...cfg, slideMode: "html" }, null);
    expect(brief).toMatch(/1920x1080/);
    expect(brief).toMatch(/bottom-right/);
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

describe("parseVideoVisuals", () => {
  const bullets = { layout: "bullets", title: "Where time goes", rows: ["context", "comments"] };
  it("takes one entry per block, null for on camera", () => {
    const { visuals, issues } = parseVideoVisuals([null, bullets, null], 3, "layouts");
    expect(issues).toEqual([]);
    expect(visuals).toEqual([null, { ...bullets, note: null }, null]);
  });
  it("parses every layout", () => {
    const all = [
      { layout: "title", title: "Every agent has a harness", subtitle: "model, inner, outer" },
      bullets,
      { layout: "compare", title: "Boundary", left: { heading: "review", rows: ["inner"] }, right: { heading: "agent", rows: ["outer"] } },
      { layout: "flow", title: "The loop", steps: ["model", "inner", "outer"] },
      { layout: "statement", text: "Start from a real failure." },
      { layout: "code", title: "Check", code: "git diff --stat" },
    ];
    expect(parseVideoVisuals(all, all.length, "layouts").issues).toEqual([]);
  });
  it("reads a layout-less outline as bullets, even when the model sends layout null", () => {
    const { visuals } = parseVideoVisuals([null, { layout: null, title: "Old", rows: ["a"] }], 2, "layouts");
    expect(visuals[1]).toMatchObject({ layout: "bullets", title: "Old" });
  });
  it("refuses a count mismatch and says the rule", () => {
    expect(parseVideoVisuals([bullets], 3, "layouts").issues.join()).toMatch(/slides_mismatch: 1 entries for 3 blocks/);
    expect(parseVideoVisuals(undefined, 3, "layouts").issues.join()).toMatch(/slides_mismatch/);
  });
  it("holds each channel to its slide mode", () => {
    expect(parseVideoVisuals([null, { html: "<div>hi</div>" }], 2, "layouts").issues.join()).toMatch(/uses layouts/);
    expect(parseVideoVisuals([null, bullets], 2, "html").issues.join()).toMatch(/designs its own slides/);
    expect(parseVideoVisuals([null, { html: "<div>hi</div>" }], 2, "html").issues).toEqual([]);
  });
  it("refuses html the sandbox would not run or fetch", () => {
    expect(parseVideoVisuals([null, { html: "<script>x()</script>" }], 2, "html").issues.join()).toMatch(/no <script>/);
    expect(parseVideoVisuals([null, { html: '<img src="https://x.com/a.png">' }], 2, "html").issues.join()).toMatch(/no external/);
    expect(parseVideoVisuals([null, { html: "<div style=\"background:url('//cdn/x.png')\"></div>" }], 2, "html").issues.join()).toMatch(/no external/);
  });
  it("names the missing field", () => {
    expect(parseVideoVisuals([{ layout: "compare", title: "x", left: { heading: "a", rows: [] } }], 1, "layouts").issues.join()).toMatch(/left and right/);
    expect(parseVideoVisuals([{ layout: "flow", title: "x", steps: ["one"] }], 1, "layouts").issues.join()).toMatch(/2-5 steps/);
    expect(parseVideoVisuals([{ layout: "wide", title: "x" }], 1, "layouts").issues.join()).toMatch(/layout must be one of/);
  });
});

describe("storedVideoVisuals", () => {
  it("reads visuals one per block", () => {
    expect(storedVideoVisuals({ visuals: [null, { html: "x" }] }, 2)).toEqual([null, { html: "x" }]);
    expect(storedVideoVisuals({ visuals: [null] }, 2)).toBeNull();
  });
  it("reads the older slides shape with the first block on camera", () => {
    const slide = { title: "One", rows: ["a"] };
    expect(storedVideoVisuals({ slides: [slide] }, 2)).toEqual([null, slide]);
    expect(storedVideoVisuals({ slides: [slide, slide] }, 2)).toBeNull();
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
    content_meta: {
      blocks: ["First spoken thought here.", "Second spoken thought here.", "Third spoken thought here."],
      visuals: [null, { layout: "bullets", title: "Two", rows: ["a"] }, null],
    },
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
  it("prices the render from the words it will speak", () => {
    const plan = planVideoRender(activity, channel);
    expect(plan.cfg.avatarId).toBe("lk_1");
    expect(plan.blocks).toHaveLength(3);
    // 12 words at 2.9 words/s.
    expect(plan.estimatedSeconds).toBe(4);
    expect(plan.estimatedCost).toBeGreaterThan(0);
  });
  it("pairs one visual per block, reading the older slides shape too", () => {
    expect(planVideoRender(activity, channel).visuals.map((v) => v === null)).toEqual([true, false, true]);
    const legacy = {
      ...activity,
      content_meta: { blocks: activity.content_meta.blocks, slides: [{ title: "Two", rows: ["a"] }, { title: "Three", rows: ["b"] }] },
    };
    expect(planVideoRender(legacy, channel).visuals.map((v) => v === null)).toEqual([true, false, false]);
    const unpaired = { ...activity, content_meta: { blocks: activity.content_meta.blocks, visuals: [null] } };
    expect(() => planVideoRender(unpaired, channel)).toThrow(/slides_mismatch/);
  });
  it("refuses without avatar + voice", () => {
    const bare = { ...channel, channel_config: {} };
    expect(() => planVideoRender(activity, bare)).toThrow(/avatar/);
  });
  it("refuses a bad script", () => {
    const bad = { ...activity, content_meta: { blocks: ["x"] } };
    expect(() => planVideoRender(bad, channel)).toThrow(/too_few_blocks/);
  });
});

describe("resolveScriptBlocks", () => {
  const stored = ["First stored thought here.", "Second stored thought here.", "Third stored thought here."];
  const base = {
    id: "a",
    persona_id: "p",
    channel_id: "ch",
    kind: "video",
    status: "approved",
    title: "Test video",
    content: "spoken script",
    content_meta: { blocks: stored },
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
  } as Parameters<typeof resolveScriptBlocks>[0];
  it("films the stored blocks when the content matches", () => {
    expect(resolveScriptBlocks({ ...base, content: stored.join("\n\n") })).toEqual(stored);
  });
  it("films the reviewed text when the queue edit differs", () => {
    const edited = "First edited thought here.\n\nSecond edited thought here.\n\nThird edited thought here.";
    expect(resolveScriptBlocks({ ...base, content: edited })).toEqual([
      "First edited thought here.",
      "Second edited thought here.",
      "Third edited thought here.",
    ]);
  });
  it("ignores edits that are not a valid script", () => {
    expect(resolveScriptBlocks({ ...base, content: "just tweaked a comma" })).toEqual(stored);
  });
  it("rejects a differing edit that fails validation instead of filming stale blocks", () => {
    const short = "First edited thought here.\n\nSecond edited thought here.";
    expect(() => resolveScriptBlocks({ ...base, content: short })).toThrow(/too_few_blocks/);
  });
  it("rejects a differing edit that breaks the visual pairing", () => {
    const edited = "First edited thought here.\n\nSecond edited thought here.\n\nThird edited thought here.\n\nFourth edited thought here.";
    const withVisuals = { ...base, content: edited, content_meta: { blocks: stored, visuals: [null, null, null] } };
    expect(() => resolveScriptBlocks(withVisuals)).toThrow(/slides_mismatch/);
    const legacy = { ...base, content: edited, content_meta: { blocks: stored, slides: [{ title: "One", rows: ["a — b"] }] } };
    expect(() => resolveScriptBlocks(legacy)).toThrow(/slides_mismatch/);
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
  it("sends the naturalness controls only when set", () => {
    const body = buildHeyGenVideoBody({
      avatarId: "lk_1",
      script: "Hello there.",
      voiceId: "v1",
      expressiveness: "high",
      motionPrompt: "Relaxed hand gestures",
      voiceSpeed: 0.95,
      resolution: "1080p",
    });
    expect(body).toMatchObject({
      expressiveness: "high",
      motion_prompt: "Relaxed hand gestures",
      voice_settings: { speed: 0.95 },
      resolution: "1080p",
    });
    const plain = buildHeyGenVideoBody({ avatarId: "lk_1", script: "Hello there.", voiceId: "v1", expressiveness: null, voiceSpeed: 3 });
    expect(plain).not.toHaveProperty("expressiveness");
    expect(plain).not.toHaveProperty("motion_prompt");
    expect(plain).not.toHaveProperty("voice_settings");
  });
  it("refuses zero or two audio sources", () => {
    expect(() => buildHeyGenVideoBody({ avatarId: "lk_1" })).toThrow(/exactly one audio source/);
    expect(() =>
      buildHeyGenVideoBody({ avatarId: "lk_1", script: "Hi.", audioAssetId: "a1" }),
    ).toThrow(/exactly one audio source/);
  });
});

describe("buildYoutubeVideoMetadata", () => {
  it("always discloses synthetic media, at the channel's visibility", () => {
    const meta = buildYoutubeVideoMetadata({
      title: "Hello",
      description: "AI-generated.",
      privacyStatus: "public",
      tags: ["code review", " ", "agents"],
    }) as { snippet: { tags: string[] }; status: { privacyStatus: string; containsSyntheticMedia: boolean } };
    expect(meta.status).toMatchObject({ privacyStatus: "public", containsSyntheticMedia: true });
    expect(meta.snippet.tags).toEqual(["code review", "agents"]);
  });
  it("requires a title", () => {
    expect(() => buildYoutubeVideoMetadata({ title: "  ", description: "x", privacyStatus: "unlisted" })).toThrow(/title is required/);
  });
});

describe("youtube OAuth state", () => {
  const prev = process.env.INFLUENCER_SECRETS_KEY;
  beforeAll(() => {
    process.env.INFLUENCER_SECRETS_KEY = "test-secret";
  });
  afterAll(() => {
    process.env.INFLUENCER_SECRETS_KEY = prev;
  });
  it("round-trips the channel and the person who pressed Connect", () => {
    const state = createYoutubeOAuthState({ channelId: "ch1", userEmail: "a@kodus.io", nonce: "n1" }, 1_000);
    expect(parseYoutubeOAuthState(state, 2_000)).toMatchObject({ channelId: "ch1", userEmail: "a@kodus.io", nonce: "n1" });
  });
  it("refuses a tampered or stale state", () => {
    const state = createYoutubeOAuthState({ channelId: "ch1", userEmail: "a@kodus.io", nonce: "n1" }, 1_000);
    const [body, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ channelId: "other", userEmail: "a@kodus.io", nonce: "n1", ts: 1_000 })).toString("base64url");
    expect(() => parseYoutubeOAuthState(`${forged}.${sig}`, 2_000)).toThrow(/signature/);
    expect(() => parseYoutubeOAuthState(`${body}.${sig}`, 1_000 + 31 * 60 * 1000)).toThrow(/expired/);
  });
  it("only finishes on the browser that started the flow", () => {
    expect(nonceMatches("n1", "n1")).toBe(true);
    expect(nonceMatches("n1", undefined)).toBe(false);
    expect(nonceMatches("n1", "n2")).toBe(false);
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
