/**
 * persona-content: daily draft generation for every active persona.
 *
 * Reuses the social-yolo machinery (feed sources → lanes → generateSocialContent
 * with the anti-slop guardrails) but swaps the user voice for the persona's own
 * voice, adds fleet-wide dedup, and writes into persona_activities. The brain
 * only ever produces drafts — publishing is persona-publish's job.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  generateSocialContent,
  type SocialContentSource,
  type SocialGenerationMode,
} from "@/lib/copilot";
import { fetchFeedPosts, type FeedItem } from "@/lib/feed-sources";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

import {
  hasGeneratedActivitiesSince,
  insertActivities,
  listRecentContents,
  type NewActivity,
} from "@/lib/influencer/activities";
import {
  listActivePersonas,
  listChannelsForPersona,
} from "@/lib/influencer/personas";
import type { Persona, PersonaChannel } from "@/lib/influencer/types";
import { buildPersonaVoicePolicy } from "@/lib/influencer/voice";

export type PersonaLane = "blog" | "hackernews" | "research" | "adversarial";

const DEFAULT_LANES: PersonaLane[] = ["hackernews", "research", "adversarial"];
const DEDUP_LOOKBACK_DAYS = 7;
const MIN_DRAFTS = 4;
const MAX_DRAFTS = 10;

type LanePlan = {
  lane: PersonaLane;
  generationMode: SocialGenerationMode;
  contentSource: SocialContentSource;
  instructions: string;
  variationStrategy: string;
  feedItems: FeedItem[];
};

function contentSignature(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}

function personaLanes(persona: Persona): PersonaLane[] {
  const raw = persona.content_config.lanes;
  if (!Array.isArray(raw)) return DEFAULT_LANES;
  const lanes = raw.filter(
    (lane): lane is PersonaLane =>
      lane === "blog" ||
      lane === "hackernews" ||
      lane === "research" ||
      lane === "adversarial",
  );
  return lanes.length ? lanes : DEFAULT_LANES;
}

function personaLanguage(persona: Persona): string {
  const raw = persona.content_config.language;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "en-US";
}

function summarizeFeedItem(item: FeedItem, position: number): string {
  const summary = (item.content || item.excerpt || "")
    .replace(/\s+/g, " ")
    .slice(0, 360)
    .trim();
  if (!summary) return "";

  return [
    `[${position}] ${item.title}`,
    `source: ${item.source}`,
    `url: ${item.link}`,
    `summary: ${summary}`,
  ].join("\n");
}

function buildLaneBaseContent(plan: LanePlan): string {
  const entries = plan.feedItems
    .map((item, index) => summarizeFeedItem(item, index + 1))
    .filter(Boolean);
  if (!entries.length) return "";

  return [
    "Use only these source updates to craft post ideas.",
    entries.join("\n\n"),
  ].join("\n\n");
}

async function buildLanePlans(persona: Persona): Promise<LanePlan[]> {
  const lanes = personaLanes(persona);
  const wanted = new Set(lanes);

  const [hn, research, competitor, blog] = await Promise.all([
    wanted.has("hackernews") || wanted.has("adversarial")
      ? fetchFeedPosts("hackernews").catch(() => [] as FeedItem[])
      : Promise.resolve([] as FeedItem[]),
    wanted.has("research")
      ? fetchFeedPosts("research").catch(() => [] as FeedItem[])
      : Promise.resolve([] as FeedItem[]),
    wanted.has("adversarial")
      ? fetchFeedPosts("competitor").catch(() => [] as FeedItem[])
      : Promise.resolve([] as FeedItem[]),
    wanted.has("blog")
      ? fetchFeedPosts("blog").catch(() => [] as FeedItem[])
      : Promise.resolve([] as FeedItem[]),
  ]);

  const plans: LanePlan[] = [];

  if (wanted.has("hackernews")) {
    plans.push({
      lane: "hackernews",
      generationMode: "content_marketing",
      contentSource: "external",
      instructions:
        "React to what the industry is discussing right now. Take a clear stance on one discussion per post, from this character's specific point of view.",
      variationStrategy:
        "Each variation must cover a different discussion or a different angle: hot take, practical implication, contrarian view, lesson.",
      feedItems: hn.slice(0, 12),
    });
  }

  if (wanted.has("research")) {
    plans.push({
      lane: "research",
      generationMode: "content_marketing",
      contentSource: "external",
      instructions:
        "Translate one recent research finding per post into something practically useful for working engineers. Reference the specific finding.",
      variationStrategy:
        "Each variation must cover a different paper or finding: surprising result, myth-busting, data point worth knowing.",
      feedItems: research.slice(0, 8),
    });
  }

  if (wanted.has("adversarial")) {
    plans.push({
      lane: "adversarial",
      generationMode: "adversarial",
      contentSource: "external",
      instructions:
        "Pick a specific claim or dominant narrative from these sources and push back with a grounded counter-position aligned with the character's worldview. Push back on the IDEA, never trash a named brand. Never strawman.",
      variationStrategy:
        "Each variation must push back on a DIFFERENT claim, or use a different angle: contradicting data, hidden trade-off, what the framing leaves out.",
      feedItems: [...competitor.slice(0, 6), ...hn.slice(0, 4)],
    });
  }

  if (wanted.has("blog")) {
    plans.push({
      lane: "blog",
      generationMode: "content_marketing",
      contentSource: "external",
      instructions:
        "Comment on these posts as things the character read and has an opinion about. The character does not own this content — react to it, extract a lesson, disagree with part of it.",
      variationStrategy:
        "Each variation must react to a different post or extract a different lesson.",
      feedItems: blog.slice(0, 8),
    });
  }

  return plans.filter((plan) => plan.feedItems.length > 0);
}

export type PersonaGenerationResult = {
  persona_id: string;
  handle: string;
  generated: number;
  skipped: boolean;
  error?: string;
};

export async function generateDraftsForPersona({
  client,
  persona,
  channel,
  fleetSignatures,
}: {
  client: SupabaseClient;
  persona: Persona;
  /** The channel the drafts are written for (the persona's X channel). */
  channel: PersonaChannel;
  /** Signatures of recent content across the whole fleet, mutated as we add. */
  fleetSignatures: Set<string>;
}): Promise<number> {
  const target = Math.min(
    MAX_DRAFTS,
    Math.max(MIN_DRAFTS, channel.max_posts_per_day * 2),
  );

  const plans = await buildLanePlans(persona);
  if (!plans.length) {
    throw new Error("No feed sources returned content for this persona's lanes.");
  }

  const voicePolicy = buildPersonaVoicePolicy(persona);
  const language = personaLanguage(persona);
  const perLane = Math.max(2, Math.ceil(target / plans.length));

  const drafts: NewActivity[] = [];

  const laneResults = await Promise.allSettled(
    plans.map(async (plan) => {
      const baseContent = buildLaneBaseContent(plan);
      if (!baseContent) return { plan, variations: [] as Awaited<ReturnType<typeof generateSocialContent>> };
      const variations = await generateSocialContent({
        baseContent,
        language,
        instructions: plan.instructions,
        variationStrategy: plan.variationStrategy,
        generationMode: plan.generationMode,
        contentSource: plan.contentSource,
        voicePolicy,
        platformConfigs: [
          {
            platform: "Twitter",
            maxLength: 280,
            numVariations: perLane,
            linksPolicy: "No link",
            ctaStyle: "No CTA, or a short question",
            hashtagsPolicy: "No hashtags",
          },
        ],
      });
      return { plan, variations };
    }),
  );

  for (const result of laneResults) {
    if (result.status === "rejected") {
      console.warn(
        `[influencer] lane generation failed for @${persona.handle}:`,
        result.reason,
      );
      continue;
    }

    const { plan, variations } = result.value;
    for (const variation of variations) {
      if (drafts.length >= target) break;
      const content = (variation.post || "").trim();
      if (!content) continue;

      const signature = contentSignature(content);
      if (fleetSignatures.has(signature)) continue;
      fleetSignatures.add(signature);

      drafts.push({
        persona_id: persona.id,
        channel_id: channel.id,
        kind: "post",
        // auto channels skip the human queue; everything else waits for review
        status: channel.automation_level === "auto" ? "approved" : "draft",
        content,
        content_meta: {
          lane: plan.lane,
          hook: variation.hook ?? "",
          cta: variation.cta ?? "",
        },
        source_kind: "feed",
        source_ref: plan.feedItems[0]?.link ?? null,
      });
    }
  }

  if (!drafts.length) return 0;

  const inserted = await insertActivities(client, drafts);
  return inserted.length;
}

function dayStartUtcIso(now: Date): string {
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return day.toISOString();
}

/** Cron entry point: one batch of drafts per active persona per UTC day. */
export async function runInfluencerContentCron(
  options: { client?: SupabaseClient; now?: Date } = {},
): Promise<PersonaGenerationResult[]> {
  const client = options.client ?? getSupabaseServiceClient();
  const now = options.now ?? new Date();
  const dayStart = dayStartUtcIso(now);

  const personas = await listActivePersonas(client);
  if (!personas.length) return [];

  const lookback = new Date(now);
  lookback.setUTCDate(lookback.getUTCDate() - DEDUP_LOOKBACK_DAYS);
  const recent = await listRecentContents(client, lookback.toISOString());
  const fleetSignatures = new Set(recent.map((row) => contentSignature(row.content)));

  const results: PersonaGenerationResult[] = [];

  for (const persona of personas) {
    const base: PersonaGenerationResult = {
      persona_id: persona.id,
      handle: persona.handle,
      generated: 0,
      skipped: false,
    };

    try {
      if (await hasGeneratedActivitiesSince(client, persona.id, dayStart)) {
        results.push({ ...base, skipped: true });
        continue;
      }

      const channels = await listChannelsForPersona(client, persona.id);
      const xChannel = channels.find(
        (ch) => ch.platform === "x" && ch.status !== "paused",
      );
      if (!xChannel) {
        results.push({ ...base, skipped: true });
        continue;
      }

      base.generated = await generateDraftsForPersona({
        client,
        persona,
        channel: xChannel,
        fleetSignatures,
      });
    } catch (error) {
      base.error = error instanceof Error ? error.message : String(error);
      console.error(
        `[influencer] content generation failed for @${persona.handle}:`,
        error,
      );
    }

    results.push(base);
  }

  return results;
}
