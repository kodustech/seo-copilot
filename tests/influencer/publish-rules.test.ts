/**
 * The publisher's hard walls are pure functions — these tests pin the sandbox
 * contract: the model can produce any draft it wants, but nothing reaches the
 * wire against automation level, daily caps, forbidden topics, or another
 * persona of the fleet.
 */
import { describe, expect, it } from "vitest";

import {
  buildFleetHandles,
  dayStartUtcIso,
  contentEnvNameFor,
  isAllowedContentEnvName,
  isAllowedDevtoEnvName,
  nextDayStartUtcIso,
  resolveBlogApiUrl,
  resolvePublishDecision,
} from "../../lib/influencer/publish";
import {
  isOnboardingComplete,
  ONBOARDING_STEP_KEYS,
  type Persona,
  type PersonaActivity,
  type PersonaChannel,
} from "../../lib/influencer/types";

const NOW = new Date("2026-08-11T15:30:00.000Z");

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    handle: "noobzero",
    display_name: "noobzero",
    bio: "bio",
    avatar_url: null,
    backstory: "backstory",
    disclosure: "I'm an AI agent operated by Kodus.",
    beat: "AI code review",
    tone: null,
    writing_guidelines: null,
    preferred_words: [],
    forbidden_words: [],
    allowed_topics: [],
    forbidden_topics: [],
    content_config: {},
    model_provider: null,
    model_name: null,
    model_base_url: null,
    mailbox_id: null,
    status: "active",
    created_by: "gabriel@kodus.io",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function makeChannel(overrides: Partial<PersonaChannel> = {}): PersonaChannel {
  return {
    id: "c1",
    persona_id: "p1",
    platform: "x",
    external_handle: "noobzero",
    publish_via: "post_bridge",
    automation_level: "approve_first",
    max_posts_per_day: 2,
    max_replies_per_day: 5,
    credentials_ref: null,
    channel_config: { post_bridge_account_id: 1 },
    onboarding: {},
    status: "active",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function makeActivity(overrides: Partial<PersonaActivity> = {}): PersonaActivity {
  return {
    id: "a1",
    persona_id: "p1",
    channel_id: "c1",
    kind: "post",
    status: "approved",
    title: null,
    content: "Shipping code nobody reviews is just gambling with extra steps.",
    content_meta: {},
    source_kind: "feed",
    source_ref: null,
    parent_activity_id: null,
    scheduled_at: null,
    published_at: null,
    external_id: null,
    external_url: null,
    error: null,
    approved_by: "gabriel@kodus.io",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function decide(overrides: {
  activity?: Partial<PersonaActivity>;
  persona?: Partial<Persona> | null;
  channel?: Partial<PersonaChannel> | null;
  fleetHandles?: Set<string>;
  publishedToday?: number;
}) {
  return resolvePublishDecision({
    activity: makeActivity(overrides.activity),
    persona:
      overrides.persona === null ? undefined : makePersona(overrides.persona),
    channel:
      overrides.channel === null ? undefined : makeChannel(overrides.channel),
    fleetHandles: overrides.fleetHandles ?? new Set(["noobzero"]),
    publishedToday: overrides.publishedToday ?? 0,
    now: NOW,
  });
}

describe("resolvePublishDecision", () => {
  it("publishes a clean approved post", () => {
    expect(decide({})).toEqual({ action: "publish" });
  });

  it("skips when the persona is paused", () => {
    const decision = decide({ persona: { status: "paused" } });
    expect(decision.action).toBe("skip");
  });

  it("skips when the channel is not active", () => {
    expect(decide({ channel: { status: "pending_setup" } }).action).toBe("skip");
    expect(decide({ channel: { status: "paused" } }).action).toBe("skip");
  });

  it("rejects on draft_only channels no matter what", () => {
    const decision = decide({
      channel: { automation_level: "draft_only" },
      activity: { status: "approved" },
    });
    expect(decision.action).toBe("reject");
  });

  it("rejects replies targeting another persona of the fleet", () => {
    const decision = decide({
      activity: {
        kind: "reply",
        content_meta: { target_handle: "@bytebender" },
      },
      fleetHandles: new Set(["noobzero", "bytebender"]),
    });
    expect(decision).toMatchObject({ action: "reject" });
    expect((decision as { reason: string }).reason).toContain("bytebender");
  });

  it("rejects content that mentions another fleet persona", () => {
    const decision = decide({
      activity: { content: "great point from @bytebender on this" },
      fleetHandles: new Set(["noobzero", "bytebender"]),
    });
    expect(decision.action).toBe("reject");
  });

  it("allows self-mentions and external mentions", () => {
    expect(
      decide({
        activity: { content: "as @noobzero always says: read the diff" },
        fleetHandles: new Set(["noobzero", "bytebender"]),
      }).action,
    ).toBe("publish");
    expect(
      decide({
        activity: { content: "interesting thread by @dhh today" },
        fleetHandles: new Set(["noobzero", "bytebender"]),
      }).action,
    ).toBe("publish");
  });

  it("rejects content touching a forbidden topic", () => {
    const decision = decide({
      persona: { forbidden_topics: ["politics"] },
      activity: { content: "hot take on politics and code review" },
    });
    expect(decision.action).toBe("reject");
  });

  it("defers to the next UTC day when the post cap is hit", () => {
    const decision = decide({ publishedToday: 2 });
    expect(decision).toMatchObject({
      action: "defer",
      until: "2026-08-12T00:00:00.000Z",
    });
  });

  it("uses the reply cap for replies and quotes", () => {
    expect(
      decide({ activity: { kind: "reply" }, publishedToday: 2 }).action,
    ).toBe("publish");
    expect(
      decide({ activity: { kind: "quote" }, publishedToday: 5 }).action,
    ).toBe("defer");
  });

  it("rejects when persona or channel is gone", () => {
    expect(decide({ persona: null }).action).toBe("reject");
    expect(decide({ channel: null }).action).toBe("reject");
  });
});

describe("buildFleetHandles", () => {
  it("collects persona handles and linked platform handles, lowercased", () => {
    const handles = buildFleetHandles(
      [makePersona(), makePersona({ id: "p2", handle: "ByteBender" })],
      [makeChannel({ external_handle: "@NoobZero_X" })],
    );
    expect(handles).toEqual(new Set(["noobzero", "bytebender", "noobzero_x"]));
  });
});

describe("isAllowedDevtoEnvName", () => {
  it("accepts the default key and per-persona suffixed keys", () => {
    expect(isAllowedDevtoEnvName("DEVTO_API_KEY")).toBe(true);
    expect(isAllowedDevtoEnvName("DEVTO_API_KEY_NOOBZERO")).toBe(true);
  });

  it("rejects arbitrary env names — credentials_ref is user-editable data", () => {
    expect(isAllowedDevtoEnvName("ANTHROPIC_API_KEY")).toBe(false);
    expect(isAllowedDevtoEnvName("DATABASE_ADMIN_URL")).toBe(false);
    expect(isAllowedDevtoEnvName("DEVTO_API_KEYX")).toBe(false);
    expect(isAllowedDevtoEnvName("devto_api_key")).toBe(false);
  });
});

describe("isOnboardingComplete", () => {
  it("requires every step, not just the ones present", () => {
    const all = Object.fromEntries(ONBOARDING_STEP_KEYS.map((key) => [key, true]));
    expect(isOnboardingComplete(all)).toBe(true);
    expect(isOnboardingComplete({ ...all, credentials_linked: false })).toBe(false);
    expect(isOnboardingComplete({})).toBe(false);
  });
});

describe("UTC day helpers", () => {
  it("computes day start and next day start", () => {
    expect(dayStartUtcIso(NOW)).toBe("2026-08-11T00:00:00.000Z");
    expect(nextDayStartUtcIso(NOW)).toBe("2026-08-12T00:00:00.000Z");
  });

  it("rolls over month boundaries", () => {
    expect(nextDayStartUtcIso(new Date("2026-08-31T23:59:00.000Z"))).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });
});

describe("blog destination", () => {
  const blogChannel = (config: Record<string, unknown>) =>
    makeChannel({ platform: "blog", publish_via: "api", channel_config: config });

  it("falls back to the default site when the channel names none", () => {
    expect(resolveBlogApiUrl(blogChannel({}))).toBe("https://aicodereview.io");
  });

  it("publishes to the site the channel names, so a farm is possible", () => {
    expect(resolveBlogApiUrl(blogChannel({ blog_api_url: "https://codereviewbench.com/" }))).toBe(
      "https://codereviewbench.com",
    );
  });

  it("refuses a host we don't own — the request carries the API key", () => {
    expect(() => resolveBlogApiUrl(blogChannel({ blog_api_url: "https://evil.com" }))).toThrow(
      /not a site we own/,
    );
  });

  it("refuses plaintext http and a malformed URL", () => {
    expect(() => resolveBlogApiUrl(blogChannel({ blog_api_url: "http://kodus.io" }))).toThrow(
      /must be https/,
    );
    expect(() => resolveBlogApiUrl(blogChannel({ blog_api_url: "not-a-url" }))).toThrow(
      /not a valid URL/,
    );
  });

  it("allows a per-site key env name, and nothing else", () => {
    expect(isAllowedContentEnvName("CONTENT_API_KEY")).toBe(true);
    expect(isAllowedContentEnvName("CONTENT_API_KEY_BENCH")).toBe(true);
    expect(isAllowedContentEnvName("SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
    expect(isAllowedContentEnvName("CONTENT_API_KEY;cat")).toBe(false);
  });

  it("does not send the shared key to a farm site", () => {
    // The connect flow writes the sentinel for every blog channel, so a farm
    // site activated through the UI would otherwise publish with the default
    // site's writer credential — and find out from the 401.
    const farm = makeChannel({
      platform: "blog",
      publish_via: "api",
      credentials_ref: "env:content_api",
      channel_config: { blog_api_url: "https://codereviewbench.com" },
    });
    expect(contentEnvNameFor(farm)).toBeNull();
    expect(
      contentEnvNameFor({ ...farm, credentials_ref: "CONTENT_API_KEY_BENCH" }),
    ).toBe("CONTENT_API_KEY_BENCH");
  });

  it("closes the same leak spelled out longhand", () => {
    // Naming CONTENT_API_KEY outright is the same request as the sentinel, and
    // credentials_ref is patchable by anyone with API access.
    const farm = makeChannel({
      platform: "blog",
      publish_via: "api",
      credentials_ref: "CONTENT_API_KEY",
      channel_config: { blog_api_url: "https://codereviewbench.com" },
    });
    expect(contentEnvNameFor(farm)).toBeNull();
  });

  it("counts the default site by host, not by literal string", () => {
    // A base URL with a path or a trailing slash is the same site, and the
    // resolver already accepts it — denying it the key would silence a channel
    // that is entitled to it.
    const at = (blog_api_url: string) =>
      contentEnvNameFor(
        makeChannel({
          platform: "blog",
          publish_via: "api",
          credentials_ref: "env:content_api",
          channel_config: { blog_api_url },
        }),
      );
    expect(at("https://aicodereview.io/")).toBe("CONTENT_API_KEY");
    expect(at("https://www.aicodereview.io")).toBe("CONTENT_API_KEY");
    expect(at("https://aicodereview.io/base//")).toBe("CONTENT_API_KEY");
    expect(at("https://codereviewbench.com/")).toBeNull();
    expect(at("not-a-url")).toBeNull();
  });

  it("counts a different scheme or port as a different service", () => {
    // The key is sent to whatever this URL names. A path doesn't change who
    // receives it; a port does, and http is refused by the resolver anyway —
    // granting the key there would have the gate promising what the publisher
    // then refuses to do.
    const at = (blog_api_url: string) =>
      contentEnvNameFor(
        makeChannel({
          platform: "blog",
          publish_via: "api",
          credentials_ref: "env:content_api",
          channel_config: { blog_api_url },
        }),
      );
    expect(at("https://aicodereview.io:8443")).toBeNull();
    expect(at("http://aicodereview.io")).toBeNull();
    expect(at("https://aicodereview.io:443")).toBe("CONTENT_API_KEY");
  });

  it("still offers the shared key when the channel names the default site", () => {
    const explicit = makeChannel({
      platform: "blog",
      publish_via: "api",
      credentials_ref: "env:content_api",
      channel_config: { blog_api_url: "https://aicodereview.io/" },
    });
    expect(contentEnvNameFor(explicit)).toBe("CONTENT_API_KEY");
  });

  it("resolves the connect flow's sentinel to the shared key", () => {
    // "env:content_api" is what the UI writes and is what the live channel
    // carries; it names no env var of its own.
    const ch = (ref: string | null) =>
      makeChannel({ platform: "blog", publish_via: "api", credentials_ref: ref });
    expect(contentEnvNameFor(ch("env:content_api"))).toBe("CONTENT_API_KEY");
    expect(contentEnvNameFor(ch(null))).toBe("CONTENT_API_KEY");
    expect(contentEnvNameFor(ch("  "))).toBe("CONTENT_API_KEY");
    expect(contentEnvNameFor(ch("CONTENT_API_KEY_BENCH"))).toBe("CONTENT_API_KEY_BENCH");
    expect(contentEnvNameFor(ch("DATABASE_URL"))).toBeNull();
  });
});
