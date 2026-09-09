/**
 * A hand-posted channel (reddit, hackernoon) is the persona writing for a
 * person to post. The shift may write for it, the publisher never touches it,
 * and the cron leaves it out of its due list.
 */
import { describe, expect, it } from "vitest";

import { manualChannelIds, resolvePublishDecision } from "../../lib/influencer/publish";
import { isActionable } from "../../lib/influencer/tick";
import type { Persona, PersonaActivity, PersonaChannel } from "../../lib/influencer/types";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function makePersona(): Persona {
  return {
    id: "p1",
    handle: "noobzero",
    display_name: "noobzero",
    bio: "bio",
    avatar_url: null,
    backstory: "backstory",
    disclosure: null,
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
  };
}

function makeChannel(overrides: Partial<PersonaChannel> = {}): PersonaChannel {
  return {
    id: "r1",
    persona_id: "p1",
    platform: "reddit",
    external_handle: null,
    publish_via: "manual",
    automation_level: "draft_only",
    max_posts_per_day: 2,
    max_replies_per_day: 5,
    credentials_ref: null,
    channel_config: {},
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
    channel_id: "r1",
    kind: "reply",
    status: "approved",
    title: null,
    content: "A useful reply.",
    content_meta: {},
    source_kind: "agent",
    source_ref: null,
    parent_activity_id: null,
    scheduled_at: null,
    published_at: null,
    external_id: null,
    external_url: null,
    error: null,
    approved_by: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("isActionable, for a hand-posted channel", () => {
  it("is open while active, even though it is draft-only", () => {
    expect(isActionable(makeChannel())).toBe(true);
    expect(isActionable(makeChannel({ platform: "hackernoon" }))).toBe(true);
  });

  it("is closed until the person turns it on", () => {
    expect(isActionable(makeChannel({ status: "pending_setup" }))).toBe(false);
    expect(isActionable(makeChannel({ status: "paused" }))).toBe(false);
  });

  it("still closes a draft-only channel that has a publisher", () => {
    // Nothing changed for the platforms the tool can publish: draft-only there
    // still means the shift does not write for it.
    expect(
      isActionable(makeChannel({ platform: "devto", publish_via: "api", credentials_ref: "vault:devto" })),
    ).toBe(false);
  });
});

describe("resolvePublishDecision, for a hand-posted channel", () => {
  it("skips rather than fails — the draft is waiting for a person, not broken", () => {
    const decision = resolvePublishDecision({
      activity: makeActivity(),
      persona: makePersona(),
      channel: makeChannel(),
      fleetHandles: new Set(),
      publishedToday: 0,
      now: NOW,
    });
    expect(decision.action).toBe("skip");
  });

  it("wins over the draft-only rejection, which would mark it failed", () => {
    const decision = resolvePublishDecision({
      activity: makeActivity(),
      persona: makePersona(),
      channel: makeChannel({ automation_level: "draft_only" }),
      fleetHandles: new Set(),
      publishedToday: 0,
      now: NOW,
    });
    expect(decision.action).toBe("skip");
  });
});

describe("manualChannelIds", () => {
  it("names only the channels a person publishes", () => {
    const ids = manualChannelIds([
      makeChannel({ id: "r1" }),
      makeChannel({ id: "h1", platform: "hackernoon" }),
      makeChannel({ id: "m1", platform: "medium", publish_via: "browser" }),
      makeChannel({ id: "x1", platform: "x", publish_via: "post_bridge" }),
    ]);
    expect(ids.sort()).toEqual(["h1", "r1"]);
  });
});
