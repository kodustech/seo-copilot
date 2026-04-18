import { generateText } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getModel } from "@/lib/ai/provider";
import { queryContentOpportunities } from "@/lib/bigquery";
import {
  searchIdeas,
  searchWebContent,
  type IdeaAngle,
} from "@/lib/exa";
import { fetchFeedPosts } from "@/lib/feed-sources";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { resolveVoicePolicyForUser } from "@/lib/voice-policy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IdeaLaneKey =
  | "topic"
  | "bubble"
  | "my_data"
  | "gap"
  | "hot_takes";

export type SuggestedFormat = "blog" | "linkedin" | "twitter" | "any";

export type IdeaCard = {
  id: string;
  lane: IdeaLaneKey;
  workingTitle: string;
  angle: string;
  whyItWorks: string;
  suggestedFormat: SuggestedFormat;
  source: {
    label: string;
    url?: string;
  } | null;
};

export type IdeaLane = {
  key: IdeaLaneKey;
  label: string;
  description: string;
  cards: IdeaCard[];
  error?: string;
};

export type IdeaSession = {
  id: string;
  userEmail: string;
  topic: string | null;
  lanes: IdeaLane[];
  cards: IdeaCard[];
  generatedAt: string;
};

const LANE_META: Record<
  IdeaLaneKey,
  { label: string; description: string }
> = {
  topic: {
    label: "Topic",
    description: "Ideas shaped around the topic you typed.",
  },
  bubble: {
    label: "Bubble",
    description: "What competitors and thought leaders are saying right now.",
  },
  my_data: {
    label: "My data",
    description:
      "Searches, pages, and queries from your own analytics that reveal gaps.",
  },
  gap: {
    label: "Gap",
    description: "Topics competitors cover that your blog does not.",
  },
  hot_takes: {
    label: "Hot takes",
    description:
      "Adversarial angles aligned with your worldview against dominant narratives.",
  },
};

const SESSION_TTL_HOURS = 6;

const DEFAULT_MAX_CARDS_PER_LANE = 5;

// ---------------------------------------------------------------------------
// Schemas for structured LLM output
// ---------------------------------------------------------------------------

const IdeaCardSchema = z.object({
  workingTitle: z.string().min(4).max(140),
  angle: z.string().min(10).max(260),
  whyItWorks: z.string().min(10).max(260),
  suggestedFormat: z
    .enum(["blog", "linkedin", "twitter", "any"])
    .default("any"),
});

const IdeaListSchema = z.object({
  ideas: z.array(IdeaCardSchema).min(1).max(8),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCardId(lane: IdeaLaneKey, seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${lane}:${slug || Math.random().toString(36).slice(2, 8)}`;
}

function safeParseJsonObject(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract the first JSON object substring
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function generateIdeasFromContext({
  laneLabel,
  contextLabel,
  contextItems,
  instruction,
  voicePrompt,
  worldview,
  maxCards,
}: {
  laneLabel: string;
  contextLabel: string;
  contextItems: string[];
  instruction: string;
  voicePrompt: string | null;
  worldview?: string | null;
  maxCards: number;
}): Promise<z.infer<typeof IdeaCardSchema>[]> {
  if (!contextItems.length) return [];

  const system = [
    `You generate raw content IDEAS (not finished posts) for a devtools company shipping an AI code-review product.`,
    `You are working on the "${laneLabel}" lane.`,
    voicePrompt ? `Voice policy:\n${voicePrompt}` : null,
    worldview
      ? `Author worldview (only applies when the lane asks for it):\n${worldview}`
      : null,
    "Each idea must be:",
    "- Concrete and specific. Not a theme, a real angle you could write a post about tomorrow.",
    "- Different from the others in the same batch. No synonym-level variations.",
    "- Expressed as a WORKING TITLE and a 1-sentence ANGLE explaining the point of view.",
    "- Accompanied by WHY IT WORKS in 1 sentence (what signal made you pick it).",
    "Never invent data, customer stories, or competitor features that are not in the context.",
    "Do NOT write the actual post content. Stop at the idea.",
    "Do NOT reference Kodus by name. Talk about the reader's point of view, not the brand.",
    "Output STRICT JSON matching: { \"ideas\": [{ workingTitle, angle, whyItWorks, suggestedFormat }] }.",
    "suggestedFormat must be one of: blog, linkedin, twitter, any.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const prompt = [
    `${contextLabel}:`,
    contextItems.map((item, i) => `[${i + 1}] ${item}`).join("\n\n"),
    "",
    instruction,
    `Generate up to ${maxCards} distinct ideas. Return JSON only.`,
  ].join("\n");

  let raw: string;
  try {
    const { text } = await generateText({
      model: getModel(),
      system,
      prompt,
    });
    raw = text;
  } catch (err) {
    console.error(`[ideas] LLM call failed for lane ${laneLabel}:`, err);
    return [];
  }

  const parsed = safeParseJsonObject(raw);
  const validation = IdeaListSchema.safeParse(parsed);
  if (!validation.success) {
    console.warn(
      `[ideas] invalid LLM output for lane ${laneLabel}:`,
      validation.error.flatten(),
    );
    return [];
  }

  return validation.data.ideas.slice(0, maxCards);
}

// ---------------------------------------------------------------------------
// Lane: Bubble (HN + competitor posts, no user input needed)
// ---------------------------------------------------------------------------

async function runBubbleLane(options: {
  voicePrompt: string | null;
  maxCards: number;
}): Promise<IdeaLane> {
  const lane: IdeaLane = {
    key: "bubble",
    ...LANE_META.bubble,
    cards: [],
  };

  try {
    const [hn, competitor] = await Promise.all([
      fetchFeedPosts("hackernews").catch(() => []),
      fetchFeedPosts("competitor").catch(() => []),
    ]);

    const contextItems = [
      ...hn.slice(0, 8).map(
        (item) =>
          `HN • ${item.title}\n${(item.excerpt || item.content || "").slice(0, 400)}`,
      ),
      ...competitor.slice(0, 8).map(
        (item) =>
          `Competitor • ${item.title} (${item.link})\n${(item.excerpt || item.content || "").slice(0, 400)}`,
      ),
    ];

    if (!contextItems.length) {
      lane.error = "No trending items found in Hacker News or competitor sources.";
      return lane;
    }

    const ideas = await generateIdeasFromContext({
      laneLabel: "Bubble",
      contextLabel: "Recent items from the AI coding / devtools bubble",
      contextItems,
      instruction:
        "Surface ideas that let the reader enter a conversation already happening in the bubble. Pick claims, debates, or trends worth having a take on.",
      voicePrompt: options.voicePrompt,
      maxCards: options.maxCards,
    });

    lane.cards = ideas.map((idea) => ({
      id: makeCardId("bubble", idea.workingTitle),
      lane: "bubble",
      workingTitle: idea.workingTitle,
      angle: idea.angle,
      whyItWorks: idea.whyItWorks,
      suggestedFormat: idea.suggestedFormat,
      source: { label: "HN + competitor trends" },
    }));
  } catch (err) {
    lane.error = err instanceof Error ? err.message : "Bubble lane failed.";
  }

  return lane;
}

// ---------------------------------------------------------------------------
// Lane: My Data (BigQuery — Search Console striking distance + low CTR)
// ---------------------------------------------------------------------------

async function runMyDataLane(options: {
  voicePrompt: string | null;
  maxCards: number;
}): Promise<IdeaLane> {
  const lane: IdeaLane = {
    key: "my_data",
    ...LANE_META.my_data,
    cards: [],
  };

  try {
    const opportunities = await queryContentOpportunities({ limit: 10 });

    const contextItems: string[] = [];
    for (const row of opportunities.strikingDistance.slice(0, 6)) {
      contextItems.push(
        `Striking-distance query: "${row.query}" on ${row.page}. Position ${row.position.toFixed(
          1,
        )}, ${row.impressions} impressions, CTR ${(row.ctr * 100).toFixed(2)}%.`,
      );
    }
    for (const row of opportunities.lowCtr.slice(0, 6)) {
      contextItems.push(
        `Low-CTR page: "${row.query}" on ${row.page}. CTR ${(row.ctr * 100).toFixed(
          2,
        )}%, ${row.impressions} impressions, position ${row.position.toFixed(1)}.`,
      );
    }

    if (!contextItems.length) {
      lane.error = "No Search Console data found for the lookback window.";
      return lane;
    }

    const ideas = await generateIdeasFromContext({
      laneLabel: "My data",
      contextLabel: "Search Console signals from your own site",
      contextItems,
      instruction:
        "Turn each strong signal into a concrete content idea: either a new focused page to capture the striking-distance query or a rewrite angle for the low-CTR page. Name the specific query or page in the angle.",
      voicePrompt: options.voicePrompt,
      maxCards: options.maxCards,
    });

    lane.cards = ideas.map((idea) => ({
      id: makeCardId("my_data", idea.workingTitle),
      lane: "my_data",
      workingTitle: idea.workingTitle,
      angle: idea.angle,
      whyItWorks: idea.whyItWorks,
      suggestedFormat: idea.suggestedFormat ?? "blog",
      source: { label: "Search Console signals" },
    }));
  } catch (err) {
    lane.error = err instanceof Error ? err.message : "My data lane failed.";
  }

  return lane;
}

// ---------------------------------------------------------------------------
// Lane: Gap (Kodus blog vs competitor posts)
// ---------------------------------------------------------------------------

async function runGapLane(options: {
  voicePrompt: string | null;
  maxCards: number;
}): Promise<IdeaLane> {
  const lane: IdeaLane = {
    key: "gap",
    ...LANE_META.gap,
    cards: [],
  };

  try {
    const [ours, theirs] = await Promise.all([
      fetchFeedPosts("blog").catch(() => []),
      fetchFeedPosts("competitor").catch(() => []),
    ]);

    if (!theirs.length) {
      lane.error =
        "No competitor posts found. Configure competitor_domains in /settings.";
      return lane;
    }

    const ourTitles = ours
      .slice(0, 40)
      .map((item) => `- ${item.title}`)
      .join("\n");
    const theirEntries = theirs.slice(0, 15).map((item) => {
      const excerpt = (item.excerpt || item.content || "").slice(0, 320);
      return `- ${item.title} (${item.link})\n  ${excerpt}`;
    });

    const contextItems = [
      `Our recent blog titles (${ours.length}):\n${ourTitles || "(empty)"}`,
      `Competitor posts (${theirs.length}):\n${theirEntries.join("\n\n")}`,
    ];

    const ideas = await generateIdeasFromContext({
      laneLabel: "Gap",
      contextLabel: "Content gap analysis",
      contextItems,
      instruction:
        "Identify topics that competitor posts cover substantively but our blog titles do not. Propose ideas that would close the gap with a stronger or different angle than the competitor's version. Do NOT copy their title; propose a fresh angle.",
      voicePrompt: options.voicePrompt,
      maxCards: options.maxCards,
    });

    lane.cards = ideas.map((idea) => ({
      id: makeCardId("gap", idea.workingTitle),
      lane: "gap",
      workingTitle: idea.workingTitle,
      angle: idea.angle,
      whyItWorks: idea.whyItWorks,
      suggestedFormat: idea.suggestedFormat ?? "blog",
      source: { label: "Blog vs competitor gap" },
    }));
  } catch (err) {
    lane.error = err instanceof Error ? err.message : "Gap lane failed.";
  }

  return lane;
}

// ---------------------------------------------------------------------------
// Lane: Hot takes (adversarial — worldview + bubble narratives)
// ---------------------------------------------------------------------------

async function runHotTakesLane(options: {
  voicePrompt: string | null;
  worldview: string | null;
  maxCards: number;
}): Promise<IdeaLane> {
  const lane: IdeaLane = {
    key: "hot_takes",
    ...LANE_META.hot_takes,
    cards: [],
  };

  try {
    const [hn, competitor] = await Promise.all([
      fetchFeedPosts("hackernews").catch(() => []),
      fetchFeedPosts("competitor").catch(() => []),
    ]);

    const contextItems = [
      ...hn.slice(0, 6).map(
        (item) =>
          `HN • ${item.title}\n${(item.excerpt || item.content || "").slice(0, 320)}`,
      ),
      ...competitor.slice(0, 6).map(
        (item) =>
          `Competitor • ${item.title}\n${(item.excerpt || item.content || "").slice(0, 320)}`,
      ),
    ];

    if (!contextItems.length) {
      lane.error = "No external narratives to push back against yet.";
      return lane;
    }

    const ideas = await generateIdeasFromContext({
      laneLabel: "Hot takes",
      contextLabel: "External narratives in the space",
      contextItems,
      instruction:
        "Each idea is an adversarial take: name a specific claim or assumption from the context that conflicts with the author's worldview, and propose a short angle pushing back. Ground each pushback in a concrete counter-observation. Do NOT name competitors to trash them; push back on the IDEA. If worldview is empty, stay narrow and skip this lane.",
      voicePrompt: options.voicePrompt,
      worldview: options.worldview,
      maxCards: options.maxCards,
    });

    lane.cards = ideas.map((idea) => ({
      id: makeCardId("hot_takes", idea.workingTitle),
      lane: "hot_takes",
      workingTitle: idea.workingTitle,
      angle: idea.angle,
      whyItWorks: idea.whyItWorks,
      suggestedFormat: idea.suggestedFormat ?? "linkedin",
      source: { label: "Worldview vs bubble narratives" },
    }));
  } catch (err) {
    lane.error = err instanceof Error ? err.message : "Hot takes lane failed.";
  }

  return lane;
}

// ---------------------------------------------------------------------------
// Lane: Topic (user-provided theme; expands via Exa searchIdeas)
// ---------------------------------------------------------------------------

async function runTopicLane(options: {
  topic: string;
  voicePrompt: string | null;
  maxCards: number;
}): Promise<IdeaLane> {
  const lane: IdeaLane = {
    key: "topic",
    ...LANE_META.topic,
    cards: [],
  };

  try {
    const { results } = await searchIdeas({
      topic: options.topic,
      daysBack: 90,
      numResultsPerAngle: 4,
    });

    const topResults = results.slice(0, 12);
    const contextItems = topResults.map((r) => {
      const angleLabel = r.angleLabel;
      return `[${angleLabel}] ${r.title}\n${r.summary ?? ""}\n${r.url}`;
    });

    if (!contextItems.length) {
      lane.error = `Exa returned no results for "${options.topic}".`;
      return lane;
    }

    const ideas = await generateIdeasFromContext({
      laneLabel: `Topic: ${options.topic}`,
      contextLabel: `External material for the topic "${options.topic}"`,
      contextItems,
      instruction: `Propose ideas that cover the topic "${options.topic}" from meaningfully different angles (pain points, questions, trends, comparisons, best practices). Each idea should stand alone.`,
      voicePrompt: options.voicePrompt,
      maxCards: options.maxCards,
    });

    // Map ideas, lifting angle labels from Exa where possible.
    const angleLabelOrder: Record<IdeaAngle, string> = {
      pain_points: "Pain Points",
      questions: "Questions",
      trends: "Trends",
      comparisons: "Comparisons",
      best_practices: "Best Practices",
    };
    void angleLabelOrder;

    lane.cards = ideas.map((idea) => ({
      id: makeCardId("topic", idea.workingTitle),
      lane: "topic",
      workingTitle: idea.workingTitle,
      angle: idea.angle,
      whyItWorks: idea.whyItWorks,
      suggestedFormat: idea.suggestedFormat,
      source: { label: `Topic: ${options.topic}` },
    }));
  } catch (err) {
    lane.error = err instanceof Error ? err.message : "Topic lane failed.";
  }

  return lane;
}

// Silence the Exa import when only used for typing.
void searchWebContent;

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function fetchLatestSessionRow(
  client: SupabaseClient,
  userEmail: string,
): Promise<IdeaSession | null> {
  const { data, error } = await client
    .from("idea_sessions")
    .select("id, user_email, topic, lanes, cards, generated_at")
    .eq("user_email", userEmail)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as {
    id: string;
    user_email: string;
    topic: string | null;
    lanes: IdeaLane[];
    cards: IdeaCard[];
    generated_at: string;
  };

  return {
    id: row.id,
    userEmail: row.user_email,
    topic: row.topic,
    lanes: row.lanes ?? [],
    cards: row.cards ?? [],
    generatedAt: row.generated_at,
  };
}

function isSessionFresh(session: IdeaSession | null, ttlHours: number): boolean {
  if (!session) return false;
  const generated = new Date(session.generatedAt).getTime();
  if (!Number.isFinite(generated)) return false;
  return Date.now() - generated < ttlHours * 60 * 60 * 1000;
}

async function persistSession({
  client,
  userEmail,
  topic,
  lanes,
}: {
  client: SupabaseClient;
  userEmail: string;
  topic: string | null;
  lanes: IdeaLane[];
}): Promise<IdeaSession> {
  const cards = lanes.flatMap((lane) => lane.cards);
  const { data, error } = await client
    .from("idea_sessions")
    .insert({
      user_email: userEmail,
      topic,
      lanes,
      cards,
    })
    .select("id, user_email, topic, lanes, cards, generated_at")
    .single();

  if (error) throw new Error(error.message);

  const row = data as {
    id: string;
    user_email: string;
    topic: string | null;
    lanes: IdeaLane[];
    cards: IdeaCard[];
    generated_at: string;
  };

  return {
    id: row.id,
    userEmail: row.user_email,
    topic: row.topic,
    lanes: row.lanes ?? [],
    cards: row.cards ?? [],
    generatedAt: row.generated_at,
  };
}

export async function generateIdeaSession({
  userEmail,
  topic,
  maxCardsPerLane = DEFAULT_MAX_CARDS_PER_LANE,
  client,
}: {
  userEmail: string;
  topic?: string | null;
  maxCardsPerLane?: number;
  client?: SupabaseClient;
}): Promise<IdeaSession> {
  const normalizedTopic = topic?.trim() ? topic.trim() : null;
  const voicePolicy = await resolveVoicePolicyForUser(userEmail);
  const voicePrompt = voicePolicy.prompt || null;
  const worldview = voicePolicy.worldview ?? null;

  const laneJobs: Promise<IdeaLane>[] = [
    runBubbleLane({ voicePrompt, maxCards: maxCardsPerLane }),
    runMyDataLane({ voicePrompt, maxCards: maxCardsPerLane }),
    runGapLane({ voicePrompt, maxCards: maxCardsPerLane }),
    runHotTakesLane({
      voicePrompt,
      worldview,
      maxCards: maxCardsPerLane,
    }),
  ];

  if (normalizedTopic) {
    laneJobs.push(
      runTopicLane({
        topic: normalizedTopic,
        voicePrompt,
        maxCards: maxCardsPerLane,
      }),
    );
  }

  const lanes = await Promise.all(laneJobs);
  // Order lanes with topic first if present, then remaining in a stable order
  const order: IdeaLaneKey[] = normalizedTopic
    ? ["topic", "bubble", "my_data", "gap", "hot_takes"]
    : ["bubble", "my_data", "gap", "hot_takes"];
  lanes.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  const supabase = client ?? getSupabaseServiceClient();
  return persistSession({
    client: supabase,
    userEmail,
    topic: normalizedTopic,
    lanes,
  });
}

export async function getOrGenerateIdeaSession({
  userEmail,
  topic,
  forceRefresh = false,
  client,
}: {
  userEmail: string;
  topic?: string | null;
  forceRefresh?: boolean;
  client?: SupabaseClient;
}): Promise<IdeaSession> {
  const supabase = client ?? getSupabaseServiceClient();

  if (!forceRefresh) {
    const latest = await fetchLatestSessionRow(supabase, userEmail);
    const normalizedTopic = topic?.trim() ? topic.trim() : null;
    const topicMatches = (latest?.topic ?? null) === normalizedTopic;
    if (latest && topicMatches && isSessionFresh(latest, SESSION_TTL_HOURS)) {
      return latest;
    }
  }

  return generateIdeaSession({ userEmail, topic, client: supabase });
}

export function ideaSessionsTableMissingMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/idea_sessions/i.test(message)) return null;
  return "The idea_sessions table is missing. Run docs/idea_sessions.sql in Supabase.";
}
