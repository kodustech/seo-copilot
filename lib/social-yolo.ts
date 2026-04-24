import type { SupabaseClient } from "@supabase/supabase-js";

import {
  generateSocialContent,
  type SocialContentSource,
  type SocialNarrativeStyle,
  type SocialSourcePerspective,
} from "@/lib/copilot";
import { fetchFeedPosts, type FeedItem } from "@/lib/feed-sources";
import { resolveVoicePolicyForUser } from "@/lib/voice-policy";

const YOLO_TIMEZONE = "America/Sao_Paulo";
const YOLO_TARGET_POSTS = 50;
const YOLO_DEFAULT_USERS = ["gabriel@kodus.io", "edvaldo.freitas@kodus.io"];
const YOLO_LANGUAGE = process.env.SOCIAL_YOLO_LANGUAGE?.trim() || "en-US";

const EDITORIAL_ANGLES = [
  {
    label: "pragmatic builder",
    hint: "Write from the perspective of a hands-on engineer who values simplicity and shipping. Prefer concrete examples over theory. Tone: direct, no-nonsense, slightly informal.",
  },
  {
    label: "strategic thinker",
    hint: "Write from the perspective of a technical leader who connects engineering decisions to business outcomes. Highlight trade-offs and long-term thinking. Tone: thoughtful, measured, authoritative.",
  },
  {
    label: "curious explorer",
    hint: "Write from the perspective of someone who loves digging into new tools and patterns. Ask provocative questions and challenge assumptions. Tone: curious, energetic, conversational.",
  },
  {
    label: "battle-tested veteran",
    hint: "Write from the perspective of someone who has seen patterns repeat across projects. Share hard-won lessons and war stories. Tone: confident, slightly opinionated, grounded in experience.",
  },
  {
    label: "community connector",
    hint: "Write from the perspective of someone who bridges teams and communities. Highlight collaboration, shared learnings, and ecosystem trends. Tone: warm, inclusive, forward-looking.",
  },
];

export type SocialYoloStatus = "draft" | "selected" | "discarded";
export type SocialYoloLane =
  | "blog"
  | "changelog"
  | "mixed"
  | "hackernews"
  | "research"
  | "adversarial";

export type SocialYoloPost = {
  id: string;
  user_email: string;
  batch_date: string;
  position: number;
  lane: SocialYoloLane;
  theme: string;
  platform: string;
  hook: string;
  content: string;
  cta: string;
  hashtags: string[];
  status: SocialYoloStatus;
  created_at: string;
  updated_at: string;
};

type SocialYoloCandidate = {
  lane: SocialYoloLane;
  theme: string;
  platform: string;
  hook: string;
  content: string;
  cta: string;
  hashtags: string[];
};

type LanePlan = {
  lane: SocialYoloLane;
  title: string;
  generationMode: "content_marketing" | "build_in_public" | "adversarial";
  contentSource: SocialContentSource;
  sourcePerspective: SocialSourcePerspective;
  narrativeStyle: SocialNarrativeStyle;
  instructions: string;
  variationStrategy: string;
  fallbackThemes: string[];
  feedItems: FeedItem[];
};

export function socialYoloTableMissingMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/social_yolo_posts/i.test(message)) {
    return null;
  }

  return [
    "The social YOLO table is missing in Supabase.",
    "Run docs/social_yolo_posts.sql and try again.",
  ].join(" ");
}

export function getDefaultYoloUsers(): string[] {
  const configured = (process.env.SOCIAL_YOLO_USERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (configured.length) {
    return Array.from(new Set(configured));
  }

  return YOLO_DEFAULT_USERS;
}

export function getYoloBatchDate(now = new Date()): string {
  return formatDateInTimezone(now, YOLO_TIMEZONE);
}

export function isYoloBatchStale(batchDate: string, now = new Date()): boolean {
  return batchDate !== getYoloBatchDate(now);
}

export async function getLatestYoloBatch(
  client: SupabaseClient,
  userEmail: string,
): Promise<{ batchDate: string | null; generatedAt: string | null; posts: SocialYoloPost[] }> {
  const { data: latestBatchRow, error: latestError } = await client
    .from("social_yolo_posts")
    .select("batch_date")
    .eq("user_email", userEmail)
    .order("batch_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) {
    throw new Error(latestError.message);
  }

  const latestBatchDate =
    typeof latestBatchRow?.batch_date === "string"
      ? latestBatchRow.batch_date
      : null;

  if (!latestBatchDate) {
    return { batchDate: null, generatedAt: null, posts: [] };
  }

  const { data: postsData, error: postsError } = await client
    .from("social_yolo_posts")
    .select("*")
    .eq("user_email", userEmail)
    .eq("batch_date", latestBatchDate)
    .order("position", { ascending: true });

  if (postsError) {
    throw new Error(postsError.message);
  }

  const posts = normalizeYoloRows(postsData);
  const generatedAt = posts[0]?.created_at ?? null;

  return {
    batchDate: latestBatchDate,
    generatedAt,
    posts,
  };
}

export async function ensureTodayYoloBatchForUser({
  client,
  userEmail,
  now = new Date(),
}: {
  client: SupabaseClient;
  userEmail: string;
  now?: Date;
}): Promise<{ generated: boolean; batchDate: string; count: number }> {
  const batchDate = getYoloBatchDate(now);
  const { data, error } = await client
    .from("social_yolo_posts")
    .select("id")
    .eq("user_email", userEmail)
    .eq("batch_date", batchDate)
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  if ((data?.length ?? 0) > 0) {
    const { count } = await countPostsForBatch(client, userEmail, batchDate);
    return { generated: false, batchDate, count };
  }

  const generated = await regenerateYoloBatchForUser({
    client,
    userEmail,
    now,
    force: false,
  });

  return {
    generated: true,
    batchDate: generated.batchDate,
    count: generated.posts.length,
  };
}

export async function regenerateYoloBatchForUser({
  client,
  userEmail,
  now = new Date(),
  force = true,
}: {
  client: SupabaseClient;
  userEmail: string;
  now?: Date;
  force?: boolean;
}): Promise<{ batchDate: string; posts: SocialYoloPost[] }> {
  const batchDate = getYoloBatchDate(now);
  const normalizedEmail = userEmail.trim().toLowerCase();

  if (force) {
    const { error } = await client
      .from("social_yolo_posts")
      .delete()
      .eq("user_email", normalizedEmail)
      .eq("batch_date", batchDate);

    if (error) {
      throw new Error(error.message);
    }
  }

  const [
    blogResult,
    changelogResult,
    hnResult,
    researchResult,
    competitorResult,
    voicePolicyResult,
  ] = await Promise.allSettled([
    fetchFeedPosts("blog"),
    fetchFeedPosts("changelog"),
    fetchFeedPosts("hackernews"),
    fetchFeedPosts("research"),
    fetchFeedPosts("competitor"),
    resolveVoicePolicyForUser(normalizedEmail),
  ]);

  const blogPosts = blogResult.status === "fulfilled" ? blogResult.value : [];
  const changelogPosts =
    changelogResult.status === "fulfilled" ? changelogResult.value : [];
  const hnPosts = hnResult.status === "fulfilled" ? hnResult.value : [];
  const researchPosts =
    researchResult.status === "fulfilled" ? researchResult.value : [];
  const competitorPosts =
    competitorResult.status === "fulfilled" ? competitorResult.value : [];
  const voicePolicy =
    voicePolicyResult.status === "fulfilled"
      ? voicePolicyResult.value
      : await resolveVoicePolicyForUser(normalizedEmail);

  if (blogResult.status === "rejected") {
    console.warn("[social-yolo] Blog source failed:", blogResult.reason);
  }
  if (changelogResult.status === "rejected") {
    console.warn("[social-yolo] Changelog source failed:", changelogResult.reason);
  }
  if (hnResult.status === "rejected") {
    console.warn("[social-yolo] Hacker News source failed:", hnResult.reason);
  }
  if (researchResult.status === "rejected") {
    console.warn("[social-yolo] Research papers source failed:", researchResult.reason);
  }
  if (competitorResult.status === "rejected") {
    console.warn("[social-yolo] Competitor source failed:", competitorResult.reason);
  }

  if (
    !blogPosts.length &&
    !changelogPosts.length &&
    !hnPosts.length &&
    !researchPosts.length &&
    !competitorPosts.length
  ) {
    throw new Error(
      "Could not fetch any content sources for YOLO generation.",
    );
  }

  const editorialAngle = pickEditorialAngle(normalizedEmail);
  const lanePlans = buildLanePlans(
    blogPosts,
    changelogPosts,
    hnPosts,
    researchPosts,
    competitorPosts,
    editorialAngle,
  );
  const activeLanePlans = lanePlans.filter((plan) => plan.feedItems.length > 0);
  if (!activeLanePlans.length) {
    throw new Error("No source content available to generate YOLO posts.");
  }

  const targetPerLane = Math.max(
    6,
    Math.ceil(YOLO_TARGET_POSTS / activeLanePlans.length),
  );

  const candidates: SocialYoloCandidate[] = [];
  const seen = new Set<string>();

  const laneResults = await Promise.allSettled(
    activeLanePlans.map((plan) =>
      generateLaneCandidates(plan, voicePolicy, targetPerLane),
    ),
  );

  for (let index = 0; index < laneResults.length; index += 1) {
    const result = laneResults[index];
    const plan = activeLanePlans[index];
    if (result.status === "rejected") {
      console.warn(`[social-yolo] Lane "${plan.lane}" failed:`, result.reason);
      continue;
    }

    pushUniqueCandidates(candidates, seen, result.value);
  }

  if (candidates.length < YOLO_TARGET_POSTS) {
    for (const plan of activeLanePlans) {
      if (candidates.length >= YOLO_TARGET_POSTS) {
        break;
      }

      const remaining = YOLO_TARGET_POSTS - candidates.length;
      const extraTarget = Math.max(4, Math.ceil(remaining / activeLanePlans.length));

      try {
        const extraPlan: LanePlan = {
          ...plan,
          variationStrategy: `${plan.variationStrategy} Avoid repeating earlier angles and examples.`,
        };
        const extraCandidates = await generateLaneCandidates(
          extraPlan,
          voicePolicy,
          extraTarget,
        );
        pushUniqueCandidates(candidates, seen, extraCandidates);
      } catch (error) {
        console.warn(
          `[social-yolo] Extra round for lane "${plan.lane}" failed:`,
          error,
        );
      }
    }
  }

  if (!candidates.length) {
    throw new Error("The assistant did not return YOLO post candidates.");
  }

  const selected = candidates.slice(0, YOLO_TARGET_POSTS);
  const payload = selected.map((item, index) => ({
    user_email: normalizedEmail,
    batch_date: batchDate,
    position: index + 1,
    lane: item.lane,
    theme: item.theme,
    platform: item.platform,
    hook: item.hook,
    content: item.content,
    cta: item.cta,
    hashtags: item.hashtags,
    status: "draft" as const,
  }));

  const { error: insertError } = await client
    .from("social_yolo_posts")
    .insert(payload);

  if (insertError) {
    throw new Error(insertError.message);
  }

  const { posts } = await getLatestYoloBatch(client, normalizedEmail);
  return { batchDate, posts };
}

async function countPostsForBatch(
  client: SupabaseClient,
  userEmail: string,
  batchDate: string,
) {
  const { count, error } = await client
    .from("social_yolo_posts")
    .select("id", { head: true, count: "exact" })
    .eq("user_email", userEmail)
    .eq("batch_date", batchDate);

  if (error) {
    throw new Error(error.message);
  }

  return { count: count ?? 0 };
}

function buildLanePlans(
  blog: FeedItem[],
  changelog: FeedItem[],
  hackernews: FeedItem[] = [],
  research: FeedItem[] = [],
  competitor: FeedItem[] = [],
  editorialAngle?: (typeof EDITORIAL_ANGLES)[number],
): LanePlan[] {
  const recentBlog = blog.slice(0, 10);
  const recentChangelog = changelog.slice(0, 14);
  const recentHn = hackernews.slice(0, 15);
  const recentResearch = research.slice(0, 10);
  const recentCompetitor = competitor.slice(0, 12);
  const mixed = interleaveFeed(recentBlog.slice(0, 6), recentChangelog.slice(0, 6));

  const angleDirective = editorialAngle
    ? `\nEditorial angle: ${editorialAngle.label}. ${editorialAngle.hint}`
    : "";

  return [
    {
      lane: "blog",
      title: "Technical thought leadership from recent blog posts",
      generationMode: "content_marketing",
      contentSource: "blog",
      sourcePerspective: "inspired",
      narrativeStyle: "lesson",
      instructions:
        `Create practical social posts for senior engineers using insights from recent blog entries. Each variation must focus on a different technical decision, trade-off, failure pattern, or implementation lesson.${angleDirective}`,
      variationStrategy:
        "Keep each variation independent and concrete. Use a different angle per variation: architecture, code review, reliability, delivery process, or team practices.",
      fallbackThemes: [
        "Architecture decisions",
        "PR review patterns",
        "Debugging lessons",
        "Delivery consistency",
        "Platform workflows",
        "Technical leadership trade-offs",
      ],
      feedItems: recentBlog,
    },
    {
      lane: "changelog",
      title: "Build in public from product changelog updates",
      generationMode: "build_in_public",
      contentSource: "changelog",
      sourcePerspective: "owned",
      narrativeStyle: "storytelling",
      instructions:
        `Create build-in-public posts showing real product progress, decisions, and implementation details from changelog updates. Keep the tone transparent and hands-on.${angleDirective}`,
      variationStrategy:
        "Each variation must highlight a different shipped change, engineering choice, learning, or follow-up plan.",
      fallbackThemes: [
        "Shipping updates",
        "Feature iteration",
        "Engineering trade-offs",
        "Product reliability",
        "Roadmap decisions",
        "Team learning",
      ],
      feedItems: recentChangelog,
    },
    {
      lane: "mixed",
      title: "Bridge product updates with evergreen engineering lessons",
      generationMode: "content_marketing",
      contentSource: "manual",
      sourcePerspective: "inspired",
      narrativeStyle: "lesson",
      instructions:
        `Blend ideas from blog and changelog sources to create posts that connect shipped work with repeatable engineering lessons. Keep each variation concise and useful.${angleDirective}`,
      variationStrategy:
        "Use a different pattern per variation: lesson learned, decision rationale, cautionary mistake, process improvement, or measurable outcome.",
      fallbackThemes: [
        "From shipping to learning",
        "Execution quality",
        "Technical communication",
        "What changed and why",
        "Engineering process",
        "Scaling practices",
      ],
      feedItems: mixed,
    },
    {
      lane: "hackernews",
      title: "AI Coding industry trends from Hacker News",
      generationMode: "content_marketing",
      contentSource: "external",
      sourcePerspective: "observed",
      narrativeStyle: "analysis",
      instructions:
        `Create posts that comment on AI Coding trends from the market, with the practical perspective of someone who builds developer tools (Kodus). Reference real discussions and take a clear stance.${angleDirective}`,
      variationStrategy:
        "Each variation must cover a different trending topic or discussion. Use angles like: industry hot take, builder perspective, practical implications, contrarian view, or lessons from the trenches.",
      fallbackThemes: [
        "AI Coding trends",
        "Developer tooling evolution",
        "LLM in production",
        "Code generation reality",
        "Agentic development",
        "AI-assisted workflows",
      ],
      feedItems: recentHn,
    },
    {
      lane: "research",
      title: "Research-backed insights on AI coding and developer productivity",
      generationMode: "content_marketing",
      contentSource: "external",
      sourcePerspective: "observed",
      narrativeStyle: "lesson",
      instructions:
        `Create posts that translate recent academic research into practical insights for engineering teams. Reference specific findings and connect them to real-world developer workflows. Make research accessible without dumbing it down.${angleDirective}`,
      variationStrategy:
        "Each variation must cover a different paper or finding. Use angles like: surprising result, practical implication, myth-busting, data point worth knowing, or connection to industry trends.",
      fallbackThemes: [
        "Research on developer productivity",
        "AI coding effectiveness studies",
        "DevEx research findings",
        "Code quality metrics",
        "Engineering team performance",
        "Automated code review research",
      ],
      feedItems: recentResearch,
    },
    {
      lane: "adversarial",
      title: "Adversarial pushback on external narratives in AI coding",
      generationMode: "adversarial",
      contentSource: "external",
      sourcePerspective: "observed",
      narrativeStyle: "hot_take",
      instructions:
        `These source items come from competitors, thought leaders, and HN discussions in the AI coding / devtools space. Pick a specific claim, assumption, or dominant narrative from them and push back against it with a grounded counter-position aligned with the author's worldview. Do not mention the author's own company or product. Do not name a competitor to trash them; push back on the IDEA, not the brand. Never strawman, never be edgy for the sake of it. If worldview is empty, stay narrow and only push back on things baseContent directly supports.${angleDirective}`,
      variationStrategy:
        "Each variation must push back on a DIFFERENT specific claim or use a DIFFERENT angle of pushback (contradicting data, exposing a hidden trade-off, naming what the dominant framing leaves out). Do NOT turn the post into a product comparison.",
      fallbackThemes: [
        "AI coding hype vs. reality",
        "Devtool metrics that mislead",
        "Review process myths",
        "Productivity narratives worth challenging",
        "PR workflow assumptions",
        "Platform engineering dogma",
      ],
      feedItems: interleaveFeed(
        recentCompetitor.slice(0, 8),
        recentHn.slice(0, 6),
      ),
    },
  ];
}

async function generateLaneCandidates(
  lanePlan: LanePlan,
  voicePolicy: Awaited<ReturnType<typeof resolveVoicePolicyForUser>>,
  targetCount: number,
): Promise<SocialYoloCandidate[]> {
  const baseContent = buildLaneBaseContent(lanePlan);
  if (!baseContent) {
    return [];
  }

  const linkedinVariations = Math.max(1, Math.ceil(targetCount / 2));
  const twitterVariations = Math.max(1, targetCount - linkedinVariations);

  const variations = await generateSocialContent({
    baseContent,
    language: YOLO_LANGUAGE,
    instructions: lanePlan.instructions,
    variationStrategy: lanePlan.variationStrategy,
    generationMode: lanePlan.generationMode,
    contentSource: lanePlan.contentSource,
    sourcePerspective: lanePlan.sourcePerspective,
    narrativeStyle: lanePlan.narrativeStyle,
    voicePolicy,
    platformConfigs: [
      {
        platform: "LinkedIn",
        maxLength: 900,
        numVariations: linkedinVariations,
        linksPolicy: "No link in body",
        ctaStyle: "Soft CTA",
        hashtagsPolicy: "Up to 3 specific hashtags",
      },
      {
        platform: "Twitter",
        maxLength: 280,
        numVariations: twitterVariations,
        linksPolicy: "No link",
        ctaStyle: "Short direct CTA",
        hashtagsPolicy: "No hashtags unless necessary",
      },
    ],
  });

  const normalized: SocialYoloCandidate[] = [];
  for (let index = 0; index < variations.length; index += 1) {
    const item = variations[index];
    const content = normalizeText(item.post);
    if (!content) continue;

    const hook = normalizeText(item.hook);
    const cta = normalizeText(item.cta);
    const hashtags = Array.isArray(item.hashtags)
      ? item.hashtags.map((entry) => normalizeHashtag(entry)).filter(Boolean)
      : [];
    const theme =
      deriveThemeFromVariation(item.hook, item.post) ||
      lanePlan.fallbackThemes[index % lanePlan.fallbackThemes.length];

    normalized.push({
      lane: lanePlan.lane,
      theme,
      platform: normalizeText(item.platform) || "Social",
      hook,
      content,
      cta,
      hashtags,
    });
  }

  return normalized.slice(0, Math.max(1, targetCount));
}

function candidateSignature(item: SocialYoloCandidate): string {
  const content = item.content.replace(/\s+/g, " ").trim().toLowerCase();
  const hook = item.hook.replace(/\s+/g, " ").trim().toLowerCase();
  const cta = item.cta.replace(/\s+/g, " ").trim().toLowerCase();
  return [item.lane, item.platform.toLowerCase(), hook, content, cta].join("|");
}

function pushUniqueCandidates(
  output: SocialYoloCandidate[],
  seen: Set<string>,
  input: SocialYoloCandidate[],
) {
  for (const candidate of input) {
    const signature = candidateSignature(candidate);
    if (seen.has(signature)) continue;
    seen.add(signature);
    output.push(candidate);
  }
}

function buildLaneBaseContent(plan: LanePlan): string {
  const entries = plan.feedItems
    .map((item, index) => summarizeFeedItem(item, index + 1))
    .filter(Boolean);

  if (!entries.length) {
    return "";
  }

  return [
    `${plan.title}.`,
    "Use only these source updates to craft post ideas.",
    entries.join("\n\n"),
  ].join("\n\n");
}

function summarizeFeedItem(item: FeedItem, position: number): string {
  const summary = normalizeText(item.content) || normalizeText(item.excerpt);
  if (!summary) return "";

  const short = summary.replace(/\s+/g, " ").slice(0, 360).trim();
  const date = item.publishedAt
    ? new Date(item.publishedAt).toISOString().slice(0, 10)
    : "unknown";

  return [
    `[${position}] ${item.title}`,
    `source: ${item.source}`,
    `date: ${date}`,
    `url: ${item.link}`,
    `summary: ${short}`,
  ].join("\n");
}

function interleaveFeed(first: FeedItem[], second: FeedItem[]): FeedItem[] {
  const output: FeedItem[] = [];
  const max = Math.max(first.length, second.length);

  for (let index = 0; index < max; index += 1) {
    if (first[index]) output.push(first[index]);
    if (second[index]) output.push(second[index]);
  }

  return output;
}

function normalizeYoloRows(payload: unknown): SocialYoloPost[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((item) => normalizeYoloRow(item))
    .filter((item): item is SocialYoloPost => Boolean(item));
}

function normalizeYoloRow(item: unknown): SocialYoloPost | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const id = normalizeText(record.id);
  const userEmail = normalizeText(record.user_email);
  const batchDate = normalizeText(record.batch_date);
  const position = Number(record.position);
  const lane = normalizeLane(record.lane);
  const theme = normalizeText(record.theme);
  const platform = normalizeText(record.platform);
  const hook = normalizeText(record.hook);
  const content = normalizeText(record.content);
  const cta = normalizeText(record.cta);
  const status = normalizeStatus(record.status);

  if (
    !id ||
    !userEmail ||
    !batchDate ||
    !Number.isInteger(position) ||
    !lane ||
    !theme ||
    !platform ||
    !content
  ) {
    return null;
  }

  const hashtags = Array.isArray(record.hashtags)
    ? record.hashtags
        .map((entry) => normalizeHashtag(entry))
        .filter(Boolean)
    : [];

  return {
    id,
    user_email: userEmail,
    batch_date: batchDate,
    position,
    lane,
    theme,
    platform,
    hook,
    content,
    cta,
    hashtags,
    status: status ?? "draft",
    created_at: normalizeText(record.created_at) || new Date().toISOString(),
    updated_at: normalizeText(record.updated_at) || new Date().toISOString(),
  };
}

function normalizeLane(value: unknown): SocialYoloLane | null {
  if (
    value === "blog" ||
    value === "changelog" ||
    value === "mixed" ||
    value === "hackernews" ||
    value === "research" ||
    value === "adversarial"
  ) {
    return value;
  }
  return null;
}

function normalizeStatus(value: unknown): SocialYoloStatus | null {
  if (value === "draft" || value === "selected" || value === "discarded") {
    return value;
  }
  return null;
}

function normalizeHashtag(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutPrefix = trimmed.replace(/^#+/, "");
  return withoutPrefix ? `#${withoutPrefix}` : "";
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function deriveThemeFromVariation(hook: string, post: string): string {
  const hookText = normalizeText(hook);
  if (hookText) {
    return hookText.slice(0, 80);
  }

  const postText = normalizeText(post).replace(/\s+/g, " ");
  if (!postText) return "";
  return postText.slice(0, 80);
}

function pickEditorialAngle(email: string): (typeof EDITORIAL_ANGLES)[number] {
  let hash = 0;
  for (let i = 0; i < email.length; i += 1) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % EDITORIAL_ANGLES.length;
  return EDITORIAL_ANGLES[index];
}

function formatDateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}
