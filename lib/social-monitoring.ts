import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { searchWebContent } from "@/lib/exa";
import { getModel } from "@/lib/ai/provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SocialPlatform = "reddit" | "twitter" | "linkedin";
export type Relevance = "high" | "medium" | "low";
export type Intent =
  | "asking_help"
  | "complaining"
  | "comparing_tools"
  | "discussing"
  | "sharing_experience";
export type MentionStatus = "new" | "contacted" | "replied" | "dismissed";

export type RawSocialResult = {
  platform: SocialPlatform;
  url: string;
  author: string | null;
  authorProfileUrl: string | null;
  title: string;
  content: string;
  publishedDate: string | null;
};

export type QualifiedMention = RawSocialResult & {
  relevance: Relevance;
  intent: Intent;
  suggestedApproach: string;
  keywordsMatched: string[];
};

export type SocialMention = {
  id: string;
  platform: SocialPlatform;
  url: string;
  author: string | null;
  author_profile_url: string | null;
  title: string;
  content: string;
  published_at: string | null;
  relevance: Relevance;
  intent: Intent;
  suggested_approach: string;
  status: MentionStatus;
  keywords_matched: string[];
  created_at: string;
  updated_at: string;
};

export type MentionFilters = {
  platform?: SocialPlatform;
  relevance?: Relevance;
  status?: MentionStatus;
  limit?: number;
  offset?: number;
};

export type MentionStats = {
  total: number;
  byPlatform: Record<string, number>;
  byStatus: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYWORDS = [
  // Direct pain points
  "code review taking too long",
  "slow pull request reviews",
  "PR review bottleneck",
  "tired of waiting for code review",
  "need better code review process",
  "code review is blocking us",
  "pull request sitting for days",
  "reviewer bandwidth problem",
  // Tool / automation intent
  "automated code review tool",
  "AI code review",
  "code review automation",
  "best code review tools 2025",
  "AI pull request review",
  "automated PR feedback",
  // Comparisons & alternatives
  "CodeRabbit vs",
  "SonarQube alternative",
  "Codacy alternative",
  "better than CodeRabbit",
  "code review tool comparison",
  // Process & culture
  "code review best practices team",
  "how to speed up code reviews",
  "code review culture engineering team",
  "reducing PR cycle time",
  "developer experience code review",
  "engineering velocity pull requests",
];

const SUBREDDITS = [
  "codereview",
  "devtools",
  "ExperiencedDevs",
  "programming",
  "softwareengineering",
  "webdev",
  "golang",
  "reactjs",
  "typescript",
  "node",
  "Python",
  "csharp",
  "java",
  "devops",
  "SaaS",
  "startups",
];

const REDDIT_USER_AGENT = "seo-copilot:social-monitor/1.0";

// ---------------------------------------------------------------------------
// Collection: Reddit (free public JSON API)
// ---------------------------------------------------------------------------

type RedditPost = {
  data: {
    id: string;
    title: string;
    selftext: string;
    url: string;
    permalink: string;
    author: string;
    created_utc: number;
    subreddit: string;
    score: number;
    num_comments: number;
  };
};

type RedditListing = {
  data: {
    children: RedditPost[];
  };
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRedditPost(post: RedditPost): RawSocialResult {
  const d = post.data;
  return {
    platform: "reddit",
    url: `https://www.reddit.com${d.permalink}`,
    author: d.author !== "[deleted]" ? d.author : null,
    authorProfileUrl:
      d.author !== "[deleted]"
        ? `https://www.reddit.com/user/${d.author}`
        : null,
    title: d.title,
    content: d.selftext
      ? d.selftext.slice(0, 1000)
      : d.title,
    publishedDate: new Date(d.created_utc * 1000).toISOString(),
  };
}

async function fetchRedditJson(url: string): Promise<RedditListing | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": REDDIT_USER_AGENT },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as RedditListing;
  } catch {
    return null;
  }
}

export async function collectReddit(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();

  function addResult(r: RawSocialResult) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      results.push(r);
    }
  }

  // Search ALL keywords across Reddit
  for (const keyword of KEYWORDS) {
    const encoded = encodeURIComponent(keyword);
    // Search last 3 days to catch things we might have missed
    const listing = await fetchRedditJson(
      `https://www.reddit.com/search.json?q=${encoded}&sort=relevance&limit=15&t=week`,
    );
    if (listing?.data?.children) {
      for (const post of listing.data.children) {
        addResult(normalizeRedditPost(post));
      }
    }
    await delay(1200);
  }

  // Browse subreddits for new posts + search within each for code review topics
  for (const subreddit of SUBREDDITS) {
    // New posts
    const newListing = await fetchRedditJson(
      `https://www.reddit.com/r/${subreddit}/new.json?limit=15`,
    );
    if (newListing?.data?.children) {
      for (const post of newListing.data.children) {
        addResult(normalizeRedditPost(post));
      }
    }
    await delay(1200);

    // Search within subreddit for code review topics
    const searchListing = await fetchRedditJson(
      `https://www.reddit.com/r/${subreddit}/search.json?q=code+review+OR+pull+request+OR+PR+review&restrict_sr=on&sort=new&limit=10&t=week`,
    );
    if (searchListing?.data?.children) {
      for (const post of searchListing.data.children) {
        addResult(normalizeRedditPost(post));
      }
    }
    await delay(1200);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Collection: Twitter/X (via Exa)
// ---------------------------------------------------------------------------

// Only accept actual tweet URLs: x.com/{user}/status/{id}
const TWEET_URL_PATTERN = /^https?:\/\/(www\.)?x\.com\/([^/]+)\/status\/\d+/;

function extractTwitterAuthor(url: string): string | null {
  const match = url.match(TWEET_URL_PATTERN);
  return match ? match[2] : null;
}

function isTweetUrl(url: string): boolean {
  return TWEET_URL_PATTERN.test(url);
}

export async function collectTwitter(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();

  for (const keyword of KEYWORDS) {
    try {
      const { results: exaResults } = await searchWebContent({
        query: keyword,
        domains: ["x.com"],
        numResults: 15,
        daysBack: 7,
        textMaxCharacters: 1000,
      });

      for (const r of exaResults) {
        if (!isTweetUrl(r.url) || seen.has(r.url)) continue;
        seen.add(r.url);

        const author = extractTwitterAuthor(r.url);
        results.push({
          platform: "twitter",
          url: r.url,
          author,
          authorProfileUrl: author ? `https://x.com/${author}` : null,
          title: r.title,
          content: r.text || r.summary || r.title,
          publishedDate: r.publishedDate ?? null,
        });
      }
    } catch {
      // Skip keyword on error, continue with others
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Collection: LinkedIn (via Exa)
// ---------------------------------------------------------------------------

// Only accept actual LinkedIn posts, not company pages, articles, job listings, etc.
const LINKEDIN_POST_PATTERN = /^https?:\/\/(www\.)?linkedin\.com\/(posts|feed|pulse)\//;

function isLinkedInPostUrl(url: string): boolean {
  return LINKEDIN_POST_PATTERN.test(url);
}

// Extra LinkedIn queries for broader discovery (thought leadership, DX topics)
const LINKEDIN_EXTRA_QUERIES = [
  "developer productivity code review workflow",
  "engineering team velocity pull request process",
  "AI code review tool experience",
  "code quality automation engineering",
  "reducing code review cycle time",
  "developer experience PR bottleneck",
  "automated code review startup",
  "code review tool recommendation",
];

export async function collectLinkedIn(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();
  const allQueries = [...KEYWORDS, ...LINKEDIN_EXTRA_QUERIES];

  for (const keyword of allQueries) {
    try {
      const { results: exaResults } = await searchWebContent({
        query: keyword,
        domains: ["linkedin.com"],
        numResults: 15,
        daysBack: 14,
        textMaxCharacters: 1500,
      });

      for (const r of exaResults) {
        if (!isLinkedInPostUrl(r.url) || seen.has(r.url)) continue;
        seen.add(r.url);

        // Try to extract author name from title (LinkedIn titles often contain author)
        const authorMatch = r.title?.match(/^(.+?)\s+(?:on LinkedIn|posted on)/i);
        const author = authorMatch?.[1] ?? null;

        results.push({
          platform: "linkedin",
          url: r.url,
          author,
          authorProfileUrl: null,
          title: r.title,
          content: r.text || r.summary || r.title,
          publishedDate: r.publishedDate ?? null,
        });
      }
    } catch {
      // Skip keyword on error, continue with others
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Collection: All platforms
// ---------------------------------------------------------------------------

export async function collectAll(): Promise<RawSocialResult[]> {
  const [reddit, twitter, linkedin] = await Promise.allSettled([
    collectReddit(),
    collectTwitter(),
    collectLinkedIn(),
  ]);

  const all = [
    ...(reddit.status === "fulfilled" ? reddit.value : []),
    ...(twitter.status === "fulfilled" ? twitter.value : []),
    ...(linkedin.status === "fulfilled" ? linkedin.value : []),
  ];

  // Dedup by URL
  const seen = new Set<string>();
  return all.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// ---------------------------------------------------------------------------
// LLM Qualification
// ---------------------------------------------------------------------------

const QUALIFICATION_SYSTEM_PROMPT = `You are a strict social media analyst for Kodus.

## What Kodus does
Kodus is an AI-powered code review tool. It automatically reviews pull requests, catches bugs, suggests improvements, and speeds up the review cycle. It integrates with GitHub/GitLab.

## Your job
Evaluate social media posts and ONLY flag ones where someone is clearly experiencing a pain that Kodus directly solves. Be VERY selective — it's better to miss an opportunity than to flag irrelevant ones.

## What counts as HIGH relevance:
- Someone complaining about slow PR reviews or review bottlenecks
- Someone asking for code review tool recommendations
- Someone discussing or comparing automated code review solutions (CodeRabbit, Codacy, SonarQube, etc.)
- Someone frustrated with code quality in their team's PRs

## What counts as MEDIUM relevance:
- Someone discussing dev team productivity challenges related to code quality or reviews
- Someone sharing experience with AI-powered dev tools in the code review/quality space
- Someone talking about improving their team's PR workflow or engineering culture around reviews
- Posts about developer experience where code review is mentioned as a pain point

## What counts as LOW relevance (DO NOT flag):
- General programming questions unrelated to code review or team workflow
- People sharing code for review (like r/codereview posts asking "review my code")
- Posts purely about CI/CD, testing, deployment, or infrastructure
- Posts about AI coding assistants (Copilot, Cursor, etc.) that are NOT about code review
- Job postings, hiring discussions
- Anything where mentioning Kodus would feel forced or spammy

## Classification
- relevance: "high" | "medium" | "low"
- intent: "asking_help" | "complaining" | "comparing_tools" | "discussing" | "sharing_experience"
- suggestedApproach: a brief, natural message (2-3 sentences). MUST reference their specific content. Be genuinely helpful, not promotional. For Reddit: suggest a comment that adds value first, mentions Kodus naturally. For Twitter/LinkedIn: suggest a reply or DM.
- worthEngaging: true if relevance is "high" or "medium" AND there's a natural way to engage
- keywordsMatched: relevant keywords

When in doubt between medium and low, prefer medium. When in doubt between high and medium, prefer medium.

Respond with a JSON array. Each element: index (0-based), relevance, intent, suggestedApproach, worthEngaging, keywordsMatched.`;

export async function qualifyMentions(
  results: RawSocialResult[],
): Promise<QualifiedMention[]> {
  if (results.length === 0) return [];

  const qualified: QualifiedMention[] = [];
  const batchSize = 10;

  for (let i = 0; i < results.length; i += batchSize) {
    const batch = results.slice(i, i + batchSize);

    const batchPayload = batch.map((r, idx) => ({
      index: idx,
      platform: r.platform,
      title: r.title,
      content: r.content.slice(0, 500),
      author: r.author,
      url: r.url,
    }));

    try {
      const { text } = await generateText({
        model: getModel(),
        system: QUALIFICATION_SYSTEM_PROMPT,
        prompt: `Evaluate these ${batch.length} social media posts:\n\n${JSON.stringify(batchPayload, null, 2)}`,
      });

      const parsed = parseQualificationResponse(text);

      for (const item of parsed) {
        if (
          !item.worthEngaging ||
          item.relevance === "low" ||
          item.index < 0 ||
          item.index >= batch.length
        ) {
          continue;
        }

        const original = batch[item.index];
        qualified.push({
          ...original,
          relevance: item.relevance,
          intent: item.intent,
          suggestedApproach: item.suggestedApproach,
          keywordsMatched: item.keywordsMatched,
        });
      }
    } catch (err) {
      console.error(
        `[social-monitoring] LLM qualification failed for batch at index ${i}:`,
        err,
      );
    }
  }

  return qualified;
}

type QualificationItem = {
  index: number;
  relevance: Relevance;
  intent: Intent;
  suggestedApproach: string;
  worthEngaging: boolean;
  keywordsMatched: string[];
};

function parseQualificationResponse(text: string): QualificationItem[] {
  // Extract JSON array from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const validRelevance = new Set(["high", "medium", "low"]);
    const validIntent = new Set([
      "asking_help",
      "complaining",
      "comparing_tools",
      "discussing",
      "sharing_experience",
    ]);

    return parsed.filter(
      (item): item is QualificationItem =>
        typeof item.index === "number" &&
        validRelevance.has(item.relevance) &&
        validIntent.has(item.intent) &&
        typeof item.suggestedApproach === "string" &&
        typeof item.worthEngaging === "boolean" &&
        Array.isArray(item.keywordsMatched),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function saveMentions(
  client: SupabaseClient,
  mentions: QualifiedMention[],
): Promise<number> {
  if (mentions.length === 0) return 0;

  const rows = mentions.map((m) => ({
    platform: m.platform,
    url: m.url,
    author: m.author,
    author_profile_url: m.authorProfileUrl,
    title: m.title,
    content: m.content,
    published_at: m.publishedDate,
    relevance: m.relevance,
    intent: m.intent,
    suggested_approach: m.suggestedApproach,
    status: "new" as const,
    keywords_matched: m.keywordsMatched,
  }));

  const { data, error } = await client
    .from("social_mentions")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");

  if (error) {
    throw new Error(`Failed to save mentions: ${error.message}`);
  }

  return data?.length ?? 0;
}

export async function listMentions(
  client: SupabaseClient,
  filters: MentionFilters = {},
): Promise<SocialMention[]> {
  let query = client
    .from("social_mentions")
    .select("*")
    .order("created_at", { ascending: false });

  if (filters.platform) {
    query = query.eq("platform", filters.platform);
  }
  if (filters.relevance) {
    query = query.eq("relevance", filters.relevance);
  }
  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.limit) {
    query = query.limit(filters.limit);
  }
  if (filters.offset) {
    query = query.range(
      filters.offset,
      filters.offset + (filters.limit || 50) - 1,
    );
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list mentions: ${error.message}`);
  }

  return (data ?? []) as SocialMention[];
}

export async function updateMentionStatus(
  client: SupabaseClient,
  id: string,
  status: MentionStatus,
): Promise<SocialMention> {
  const { data, error } = await client
    .from("social_mentions")
    .update({ status })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update mention: ${error.message}`);
  }

  return data as SocialMention;
}

export async function getMentionStats(
  client: SupabaseClient,
): Promise<MentionStats> {
  const { data, error } = await client
    .from("social_mentions")
    .select("platform, status");

  if (error) {
    throw new Error(`Failed to get mention stats: ${error.message}`);
  }

  const rows = (data ?? []) as { platform: string; status: string }[];

  const byPlatform: Record<string, number> = {};
  const byStatus: Record<string, number> = {};

  for (const row of rows) {
    byPlatform[row.platform] = (byPlatform[row.platform] || 0) + 1;
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }

  return {
    total: rows.length,
    byPlatform,
    byStatus,
  };
}

// ---------------------------------------------------------------------------
// Full sync (used by cron)
// ---------------------------------------------------------------------------

export async function syncSocialMentions(
  client: SupabaseClient,
): Promise<{ collected: number; qualified: number; saved: number }> {
  const collected = await collectAll();
  const qualified = await qualifyMentions(collected);
  const saved = await saveMentions(client, qualified);

  return {
    collected: collected.length,
    qualified: qualified.length,
    saved,
  };
}
