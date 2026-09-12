/**
 * Influencer module: a fleet of openly-AI personas that draft, publish and
 * learn. Public shapes stay snake_case, same as the rest of the app's API
 * surface. Enum values mirror the check constraints in docs/influencer.sql.
 */

export type PersonaStatus = "active" | "paused";

export type ChannelPlatform =
  | "x"
  | "devto"
  | "blog"
  | "medium"
  | "reddit"
  | "hackernews"
  // Hacker Noon, not Hacker News: a different site, and a manual channel — it
  // has no publishing API and every story passes a human editor.
  | "hackernoon";

// "browser" drives the persona's logged-in session in a remote browser. It is
// how Medium gets published: the API stopped issuing integration tokens in 2023,
// and "Import a story" is the one automated path it still has.
export type PublishVia = "post_bridge" | "api" | "n8n" | "manual" | "browser";

/**
 * How a channel is born, per platform. It lives here because the creation route
 * and its tests both need it, and because a channel nobody creates is invisible
 * until a persona cannot publish to the site it exists for. That is exactly what
 * happened: the wizard seeded six channels and left out the blog, so a persona
 * built to write a farm site had nowhere to write.
 *
 * `publish_via` on a blog is metadata rather than a switch. publishActivity
 * dispatches on `platform === "blog"` before it ever reads publish_via, so the
 * value only has to be honest about what happens, which is the site's own
 * content API. One long-form page a day is already more than a site this size
 * needs, and a blog has no replies to write.
 */
export function channelDefaults(platform: ChannelPlatform): {
  publish_via: PublishVia;
  automation_level: AutomationLevel;
  max_posts_per_day: number;
  max_replies_per_day: number;
} {
  switch (platform) {
    case "x":
      return { publish_via: "post_bridge", automation_level: "approve_first", max_posts_per_day: 2, max_replies_per_day: 5 };
    case "devto":
      return { publish_via: "api", automation_level: "approve_first", max_posts_per_day: 2, max_replies_per_day: 5 };
    case "blog":
      return { publish_via: "api", automation_level: "approve_first", max_posts_per_day: 1, max_replies_per_day: 0 };
    case "medium":
      return { publish_via: "browser", automation_level: "approve_first", max_posts_per_day: 2, max_replies_per_day: 5 };
    // Hand-posted: the tool writes, a person posts from their own account.
    case "reddit":
    case "hackernews":
    case "hackernoon":
      return { publish_via: "manual", automation_level: "draft_only", max_posts_per_day: 2, max_replies_per_day: 5 };
  }
}

export type AutomationLevel = "auto" | "approve_first" | "draft_only";

export type ChannelStatus = "pending_setup" | "active" | "paused";

export type ActivityKind = "post" | "reply" | "quote" | "article" | "crosspost";

export type ActivityStatus =
  | "draft"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "discarded";

export type LearningKind = "works" | "avoid";

export type ModelProvider =
  | "kimi"
  | "google"
  | "openai"
  | "anthropic"
  // Bring-your-own endpoint (subscription gateway, coding-plan endpoint,
  // proxy, OpenRouter, LiteLLM, …). Uses model_base_url + the stored token.
  | "openai_compatible"
  | "anthropic_compatible";

export type Persona = {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  backstory: string;
  // Optional: when set, the persona operates openly as AI and honors this line.
  // When null, the creator has chosen not to disclose.
  disclosure: string | null;
  beat: string;
  tone: string | null;
  writing_guidelines: string | null;
  preferred_words: string[];
  forbidden_words: string[];
  allowed_topics: string[];
  forbidden_topics: string[];
  content_config: Record<string, unknown>;
  // Which provider/model this persona operates on. null = global default.
  model_provider: ModelProvider | null;
  model_name: string | null;
  // Custom endpoint for the *_compatible providers (base URL of the gateway).
  model_base_url: string | null;
  // Linked outreach mailbox so the persona can send/read email.
  mailbox_id: string | null;
  status: PersonaStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type PersonaCredentialMeta = {
  provider: ModelProvider;
  key_last4: string;
  label: string | null;
  status: "active" | "revoked";
  created_at: string;
};

export type PersonaChannel = {
  id: string;
  persona_id: string;
  platform: ChannelPlatform;
  external_handle: string | null;
  publish_via: PublishVia;
  automation_level: AutomationLevel;
  max_posts_per_day: number;
  max_replies_per_day: number;
  credentials_ref: string | null;
  channel_config: Record<string, unknown>;
  onboarding: Record<string, boolean>;
  status: ChannelStatus;
  created_at: string;
  updated_at: string;
};

export type PersonaActivity = {
  id: string;
  persona_id: string;
  channel_id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string | null;
  content: string;
  content_meta: Record<string, unknown>;
  source_kind: string | null;
  source_ref: string | null;
  parent_activity_id: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  external_id: string | null;
  external_url: string | null;
  error: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PersonaLearning = {
  id: string;
  persona_id: string;
  kind: LearningKind;
  insight: string;
  evidence: Record<string, unknown>;
  status: "active" | "retired";
  created_at: string;
};

const PERSONA_STATUSES: PersonaStatus[] = ["active", "paused"];
export const CHANNEL_PLATFORMS: ChannelPlatform[] = [
  "x",
  "devto",
  "blog",
  "medium",
  "reddit",
  "hackernews",
  "hackernoon",
];
const AUTOMATION_LEVELS: AutomationLevel[] = [
  "auto",
  "approve_first",
  "draft_only",
];
const CHANNEL_STATUSES: ChannelStatus[] = ["pending_setup", "active", "paused"];
const ACTIVITY_KINDS: ActivityKind[] = [
  "post",
  "reply",
  "quote",
  "article",
  "crosspost",
];
const ACTIVITY_STATUSES: ActivityStatus[] = [
  "draft",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "discarded",
];

export function normalizePersonaStatus(value: unknown): PersonaStatus | null {
  return PERSONA_STATUSES.includes(value as PersonaStatus)
    ? (value as PersonaStatus)
    : null;
}

export function normalizeChannelPlatform(
  value: unknown,
): ChannelPlatform | null {
  return CHANNEL_PLATFORMS.includes(value as ChannelPlatform)
    ? (value as ChannelPlatform)
    : null;
}

const MODEL_PROVIDERS: ModelProvider[] = [
  "kimi",
  "google",
  "openai",
  "anthropic",
  "openai_compatible",
  "anthropic_compatible",
];

export function normalizeModelProvider(value: unknown): ModelProvider | null {
  return MODEL_PROVIDERS.includes(value as ModelProvider)
    ? (value as ModelProvider)
    : null;
}

export function normalizeAutomationLevel(
  value: unknown,
): AutomationLevel | null {
  return AUTOMATION_LEVELS.includes(value as AutomationLevel)
    ? (value as AutomationLevel)
    : null;
}

export function normalizeChannelStatus(value: unknown): ChannelStatus | null {
  return CHANNEL_STATUSES.includes(value as ChannelStatus)
    ? (value as ChannelStatus)
    : null;
}

export function normalizeActivityKind(value: unknown): ActivityKind | null {
  return ACTIVITY_KINDS.includes(value as ActivityKind)
    ? (value as ActivityKind)
    : null;
}

export function normalizeActivityStatus(value: unknown): ActivityStatus | null {
  return ACTIVITY_STATUSES.includes(value as ActivityStatus)
    ? (value as ActivityStatus)
    : null;
}

/** Replies and quotes count against max_replies_per_day; the rest against max_posts_per_day. */
export function isReplyKind(kind: ActivityKind): boolean {
  return kind === "reply" || kind === "quote";
}

/**
 * The onboarding checklist a channel must complete before it can activate.
 * Enforced server-side on the channel PATCH — the UI checklist is a mirror,
 * not the wall.
 */
export const ONBOARDING_STEP_KEYS = [
  "account_created",
  "automation_label",
  "disclosure_in_bio",
  "credentials_linked",
] as const;

export function isOnboardingComplete(
  onboarding: Record<string, boolean>,
): boolean {
  return ONBOARDING_STEP_KEYS.every((key) => onboarding[key]);
}

export function influencerTableMissingMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !/persona(s|_channels|_activities|_activity_metrics|_learnings|_credentials|_sessions|_session_steps)/i.test(
      message,
    )
  ) {
    return null;
  }
  if (!/does not exist|relation/i.test(message)) {
    return null;
  }
  return "The influencer tables are missing in Supabase. Apply supabase/migrations/20260812000000_influencer.sql (supabase db push, or paste docs/influencer.sql in the SQL editor) and try again.";
}
