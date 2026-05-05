import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { searchWebContent } from "@/lib/exa";
import { getModel } from "@/lib/ai/provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SocialPlatform =
  | "reddit"
  | "twitter"
  | "linkedin"
  | "hackernews"
  | "web"
  | "github";
export type Relevance = "high" | "medium" | "low";
export type Intent =
  | "asking_help"
  | "complaining"
  | "comparing_tools"
  | "discussing"
  | "sharing_experience"
  | "backlink_opportunity"
  | "competitor_listicle";
export type MentionStatus = "new" | "contacted" | "replied" | "dismissed";

const VALID_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  "asking_help",
  "complaining",
  "comparing_tools",
  "discussing",
  "sharing_experience",
  "backlink_opportunity",
  "competitor_listicle",
]);

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

/** Run async tasks in parallel batches to avoid overwhelming APIs */
async function batchParallel<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency = 5,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(fn));
  }
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

// Focused Reddit queries via Exa (semantic search finds much more than Reddit's own API)
const REDDIT_EXA_QUERIES = [
  // Direct pain — high intent
  "code review taking too long frustrated",
  "slow pull request reviews blocking team",
  "PR review bottleneck engineering",
  "tired of waiting for code review",
  "need better code review process",
  // Tool discovery
  "what code review tool do you recommend",
  "automated code review AI experience",
  "best code review tools 2025",
  "CodeRabbit vs SonarQube vs Codacy",
  "AI pull request review tool",
  // Process
  "how to speed up code reviews team",
  "code review culture engineering workflow",
  "reducing PR cycle time developer experience",
];

export async function collectReddit(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();

  function addResult(r: RawSocialResult) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      results.push(r);
    }
  }

  // Primary: Exa semantic search on reddit.com (parallel batches of 5)
  await batchParallel(
    REDDIT_EXA_QUERIES,
    async (keyword) => {
      try {
        const { results: exaResults } = await searchWebContent({
          query: keyword,
          domains: ["reddit.com"],
          numResults: 15,
          daysBack: 14,
          textMaxCharacters: 1500,
        });

        for (const r of exaResults) {
          if (!r.url.includes("reddit.com/r/")) continue;
          addResult({
            platform: "reddit",
            url: r.url,
            author: null,
            authorProfileUrl: null,
            title: r.title || "",
            content: r.text || r.summary || r.title || "",
            publishedDate: r.publishedDate ?? null,
          });
        }
      } catch {
        // Skip on error
      }
    },
    5,
  );

  // Secondary: Reddit public API for very fresh posts from top subreddits
  const coreSubreddits = SUBREDDITS.slice(0, 5);
  for (const subreddit of coreSubreddits) {
    const newListing = await fetchRedditJson(
      `https://www.reddit.com/r/${subreddit}/new.json?limit=15`,
    );
    if (newListing?.data?.children) {
      for (const post of newListing.data.children) {
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

// Focused Twitter queries (subset of keywords most likely to appear on X)
const TWITTER_EXA_QUERIES = [
  "code review taking too long",
  "AI code review tool",
  "automated code review",
  "PR review bottleneck",
  "code review automation",
  "CodeRabbit alternative",
  "best code review tools",
  "pull request review slow",
  "developer experience code review",
  "code review tool comparison",
];

export async function collectTwitter(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();

  await batchParallel(
    TWITTER_EXA_QUERIES,
    async (keyword) => {
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
        // Skip on error
      }
    },
    5,
  );

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

// Focused LinkedIn queries for discovery
const LINKEDIN_EXA_QUERIES = [
  "code review taking too long engineering team",
  "AI code review tool experience",
  "developer productivity code review workflow",
  "engineering team velocity pull request process",
  "automated code review startup",
  "code review tool recommendation",
  "reducing code review cycle time",
  "PR review bottleneck developer experience",
  "code quality automation engineering",
  "best code review tools 2025",
  "CodeRabbit alternative code review",
  "slow pull request reviews blocking",
  "code review culture engineering",
];

export async function collectLinkedIn(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();

  await batchParallel(
    LINKEDIN_EXA_QUERIES,
    async (keyword) => {
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
        // Skip on error
      }
    },
    5,
  );

  return results;
}

// ---------------------------------------------------------------------------
// Collection: Hacker News (Algolia search API — free, no key)
// ---------------------------------------------------------------------------

// HN Algolia returns a flat hit shape covering both stories and comments.
// We treat both as social mentions: stories are listicle/competitor candidates,
// comments are where Kodus is most often mentioned without a link.
type HnHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  story_url?: string | null;
  story_title?: string | null;
  comment_text?: string | null;
  story_text?: string | null;
  author: string | null;
  created_at: string;
  _tags?: string[];
};

const HACKERNEWS_QUERIES = [
  "ai code review",
  "automated code review",
  "code review tool",
  "best code review tools",
  "coderabbit",
  "kodus",
  "kody review",
  "pull request review automation",
];

const HN_LOOKBACK_DAYS = 30;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHnHit(hit: HnHit): RawSocialResult | null {
  const isComment = hit._tags?.includes("comment") ?? false;
  const authorProfileUrl = hit.author
    ? `https://news.ycombinator.com/user?id=${hit.author}`
    : null;

  if (isComment) {
    if (!hit.comment_text) return null;
    return {
      platform: "hackernews",
      url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      author: hit.author,
      authorProfileUrl,
      title: hit.story_title || "(comment on HN thread)",
      content: stripHtml(hit.comment_text).slice(0, 1500),
      publishedDate: hit.created_at ?? null,
    };
  }

  if (!hit.title) return null;
  const externalUrl = hit.url ?? null;
  const url = externalUrl
    ? externalUrl
    : `https://news.ycombinator.com/item?id=${hit.objectID}`;
  const baseContent = hit.story_text
    ? stripHtml(hit.story_text)
    : hit.title;
  return {
    platform: "hackernews",
    url,
    author: hit.author,
    authorProfileUrl,
    title: hit.title,
    content: baseContent.slice(0, 1500),
    publishedDate: hit.created_at ?? null,
  };
}

export async function collectHackerNews(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();
  const cutoff = Math.floor(
    (Date.now() - HN_LOOKBACK_DAYS * 86_400_000) / 1000,
  );

  function add(r: RawSocialResult | null) {
    if (!r || seen.has(r.url)) return;
    seen.add(r.url);
    results.push(r);
  }

  await batchParallel(
    HACKERNEWS_QUERIES,
    async (query) => {
      // Stories AND comments — both are useful for backlink discovery. Stories
      // catch listicles + brand mentions in articles; comments catch
      // user-written competitor comparisons that often name Kodus without a
      // link.
      for (const tag of ["story", "comment"] as const) {
        try {
          const url =
            `https://hn.algolia.com/api/v1/search?` +
            `query=${encodeURIComponent(query)}` +
            `&tags=${tag}` +
            `&numericFilters=created_at_i>${cutoff}` +
            `&hitsPerPage=30`;
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) continue;
          const data = (await res.json()) as { hits: HnHit[] };
          for (const hit of data.hits ?? []) {
            add(normalizeHnHit(hit));
          }
        } catch {
          // Skip on error — Algolia is occasionally rate limited
        }
      }
    },
    3,
  );

  return results;
}

// ---------------------------------------------------------------------------
// Collection: Web (listicles + experience posts on dev.to / medium / blogs)
// ---------------------------------------------------------------------------

// Listicle queries — broad, no domain restriction. Catches "Best AI Code
// Review Tools 2026" style roundups across any blog. The qualifier decides if
// each is competitor_listicle (no Kodus mention) or backlink_opportunity
// (mentioned without link) or noise.
const WEB_LISTICLE_QUERIES = [
  "best AI code review tools 2026",
  "best code review tools 2026",
  "automated code review tool comparison",
  "CodeRabbit alternatives",
  "AI pull request review tools",
  "best automated PR review tools",
  "GitHub code review automation tools",
  "top code review tools developers",
];

// Experience-post queries — narrower domain, fresher window. Catches
// developer-written reviews ("My experience with CodeRabbit") that often
// mention Kodus in passing without a link.
const WEB_EXPERIENCE_QUERIES = [
  "my experience with CodeRabbit",
  "AI code review tool review",
  "switched from manual code review to AI",
  "automated code review changed our team",
  "code review tool I tried",
];

const WEB_EXPERIENCE_DOMAINS = [
  "dev.to",
  "medium.com",
  "hashnode.com",
  "hashnode.dev",
  "substack.com",
];

// Exclude our own properties + obvious non-articles.
const WEB_EXCLUDE_DOMAINS = [
  "kodus.io",
  "aicodereviews.io",
  "codereviewbench.com",
  "youtube.com",
  "github.com",
];

export async function collectWeb(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();

  function add(r: RawSocialResult) {
    if (seen.has(r.url)) return;
    seen.add(r.url);
    results.push(r);
  }

  // Track upstream errors per query so a quota/API failure is visible in
  // logs instead of silently producing zero results.
  let exaErrors = 0;

  // Listicles — broad, year-old still useful
  await batchParallel(
    WEB_LISTICLE_QUERIES,
    async (query) => {
      try {
        const { results: exaResults } = await searchWebContent({
          query,
          excludeDomains: WEB_EXCLUDE_DOMAINS,
          numResults: 10,
          daysBack: 365,
          textMaxCharacters: 3000,
        });
        for (const r of exaResults) {
          if (!r.url || !r.title) continue;
          add({
            platform: "web",
            url: r.url,
            author: null,
            authorProfileUrl: null,
            title: r.title,
            content: r.text || r.summary || r.title,
            publishedDate: r.publishedDate ?? null,
          });
        }
      } catch (err) {
        exaErrors++;
        console.error(
          `[social-monitoring] collectWeb listicle "${query}" failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    },
    3,
  );

  // Experience posts — narrower, fresher
  await batchParallel(
    WEB_EXPERIENCE_QUERIES,
    async (query) => {
      try {
        const { results: exaResults } = await searchWebContent({
          query,
          domains: WEB_EXPERIENCE_DOMAINS,
          numResults: 10,
          daysBack: 90,
          textMaxCharacters: 3000,
        });
        for (const r of exaResults) {
          if (!r.url || !r.title) continue;
          add({
            platform: "web",
            url: r.url,
            author: null,
            authorProfileUrl: null,
            title: r.title,
            content: r.text || r.summary || r.title,
            publishedDate: r.publishedDate ?? null,
          });
        }
      } catch (err) {
        exaErrors++;
        console.error(
          `[social-monitoring] collectWeb experience "${query}" failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    },
    3,
  );

  if (exaErrors > 0) {
    console.warn(
      `[social-monitoring] collectWeb saw ${exaErrors} upstream Exa errors — likely quota/credits issue`,
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Collection: GitHub awesome lists (free Search API, optional auth)
// ---------------------------------------------------------------------------

type GhRepo = {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  archived: boolean;
  owner: { login: string; html_url: string };
};

type GhSearchResponse = { items?: GhRepo[] };
type GhReadmeResponse = { content: string; encoding: string; html_url: string };

const GITHUB_AWESOME_QUERIES = [
  "awesome-code-review",
  "awesome-ai-code-review",
  "awesome-ai-tools",
  "awesome-developer-tools",
  "awesome-code-quality",
  "awesome-devtools",
  "awesome-static-analysis",
  "awesome-ai-developer-tools",
];

// Repos we own and shouldn't pitch to.
const GITHUB_OWNED_LISTS = new Set([
  "kodustech/awesome-ai-code-review",
]);

const GITHUB_MIN_STARS = 50;

export async function collectGitHubAwesome(): Promise<RawSocialResult[]> {
  const results: RawSocialResult[] = [];
  const seen = new Set<string>();
  const token = process.env.GITHUB_TOKEN?.trim();

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "seo-copilot:backlink-discovery/1.0",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (const query of GITHUB_AWESOME_QUERIES) {
    try {
      const searchUrl =
        `https://api.github.com/search/repositories?` +
        `q=${encodeURIComponent(query)}` +
        `&sort=stars&per_page=10`;
      const searchRes = await fetch(searchUrl, { headers, cache: "no-store" });
      if (!searchRes.ok) continue;
      const searchData = (await searchRes.json()) as GhSearchResponse;

      for (const repo of searchData.items ?? []) {
        if (seen.has(repo.html_url)) continue;
        if (repo.archived) continue;
        if (repo.stargazers_count < GITHUB_MIN_STARS) continue;
        if (GITHUB_OWNED_LISTS.has(repo.full_name.toLowerCase())) continue;
        seen.add(repo.html_url);

        try {
          const readmeRes = await fetch(
            `https://api.github.com/repos/${repo.full_name}/readme`,
            { headers, cache: "no-store" },
          );
          if (!readmeRes.ok) continue;
          const readmeData = (await readmeRes.json()) as GhReadmeResponse;
          if (readmeData.encoding !== "base64") continue;
          const readme = Buffer.from(readmeData.content, "base64").toString(
            "utf-8",
          );

          // Skip lists that already include us — we want gaps, not duplicates.
          if (/\bkodus(\.io)?\b/i.test(readme)) continue;

          // Skip lists that don't mention code review at all — qualifier
          // would reject as low relevance anyway, but cheaper to filter early.
          if (!/code\s*review|pull\s*request|pr\s*review/i.test(readme)) {
            continue;
          }

          results.push({
            platform: "github",
            url: repo.html_url,
            author: repo.owner.login,
            authorProfileUrl: repo.owner.html_url,
            title: `${repo.full_name} — ${repo.description ?? "(awesome list)"}`,
            content: readme.slice(0, 3000),
            publishedDate: null,
          });
        } catch {
          // Skip this repo
        }

        await delay(400); // be polite to GitHub API
      }
    } catch {
      // Skip query
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Collection: All platforms
// ---------------------------------------------------------------------------

export async function collectAll(): Promise<RawSocialResult[]> {
  const [reddit, twitter, linkedin, hn, web, gh] = await Promise.allSettled([
    collectReddit(),
    collectTwitter(),
    collectLinkedIn(),
    collectHackerNews(),
    collectWeb(),
    collectGitHubAwesome(),
  ]);

  const all = [
    ...(reddit.status === "fulfilled" ? reddit.value : []),
    ...(twitter.status === "fulfilled" ? twitter.value : []),
    ...(linkedin.status === "fulfilled" ? linkedin.value : []),
    ...(hn.status === "fulfilled" ? hn.value : []),
    ...(web.status === "fulfilled" ? web.value : []),
    ...(gh.status === "fulfilled" ? gh.value : []),
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

## Backlink-specific HIGH relevance (flag even when engagement isn't the point)
- "competitor_listicle": post is a listicle/roundup of code review or AI dev tools (e.g., "Best AI Code Review Tools 2026", "10 CodeRabbit alternatives") that does NOT include Kodus. We want to request inclusion. Also applies to GitHub "awesome-*" lists where Kodus is missing — in that case, suggestedApproach should outline the PR (the entry to add, in the list's existing format).
- "backlink_opportunity": post mentions Kodus, kodus.io, or describes our product without linking back to us. We want to ask for a backlink.

For platforms = "web" or "github", these intents are the default expectation:
- "web": review/listicle/experience post on a blog, dev.to, medium, etc. Almost always either competitor_listicle (no Kodus) or backlink_opportunity (Kodus mentioned, no link).
- "github": awesome-list repo. competitor_listicle is the right intent if the README is on-topic for code review / AI dev tools but doesn't include Kodus.

For "web" + "github" results, suggestedApproach should describe the *outreach* (who to email, what to say, what proof points to mention) or the *PR draft* — not a comment reply. Ed will execute these manually, so include the concrete next action.

## What counts as LOW relevance (DO NOT flag):
- General programming questions unrelated to code review or team workflow
- People sharing code for review (like r/codereview posts asking "review my code")
- Posts purely about CI/CD, testing, deployment, or infrastructure
- Posts about AI coding assistants (Copilot, Cursor, etc.) that are NOT about code review
- Job postings, hiring discussions
- Anything where mentioning Kodus would feel forced or spammy

## Classification
- relevance: "high" | "medium" | "low"
- intent: one of "asking_help" | "complaining" | "comparing_tools" | "discussing" | "sharing_experience" | "backlink_opportunity" | "competitor_listicle"
- suggestedApproach: a brief, natural message (2-3 sentences). MUST reference their specific content. Be genuinely helpful, not promotional.
  - For Reddit/HN comments: suggest a reply that adds value first, mentions Kodus naturally
  - For Twitter/LinkedIn: suggest a reply or DM
  - For "competitor_listicle" / "backlink_opportunity": describe the outreach — what email/DM to send and the proof points to mention (open-source, Kody Rules, MCP, IDE-native multi-agent)
- worthEngaging: true if relevance is "high" or "medium" AND there's a way to act on it. ALWAYS set worthEngaging=true when intent is "competitor_listicle" or "backlink_opportunity" — for backlink intents, the action is outreach (email/PR), not a comment thread, so the lack of an engagement hook is irrelevant.
- keywordsMatched: relevant keywords

When in doubt between medium and low, prefer medium. When in doubt between high and medium, prefer medium.

Respond with a JSON array. Each element: index (0-based), relevance, intent, suggestedApproach, worthEngaging, keywordsMatched.`;

export async function qualifyMentions(
  results: RawSocialResult[],
): Promise<QualifiedMention[]> {
  if (results.length === 0) return [];

  const qualified: QualifiedMention[] = [];
  const batchSize = 10;

  // Track rejection reasons so silent zeros become diagnosable next time.
  const rejections = {
    parseFail: 0,
    lowRelevance: 0,
    notWorthEngaging: 0,
    invalidIndex: 0,
    byPlatform: {} as Record<string, number>,
  };

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
      if (parsed.length === 0) {
        rejections.parseFail += batch.length;
        continue;
      }

      for (const item of parsed) {
        if (item.index < 0 || item.index >= batch.length) {
          rejections.invalidIndex++;
          continue;
        }
        const original = batch[item.index];
        const isBacklinkIntent =
          item.intent === "competitor_listicle" ||
          item.intent === "backlink_opportunity";

        if (item.relevance === "low") {
          rejections.lowRelevance++;
          rejections.byPlatform[original.platform] =
            (rejections.byPlatform[original.platform] || 0) + 1;
          continue;
        }
        // Backlink intents never need an engagement hook — outreach is the
        // action. Bypass worthEngaging so listicles + awesome-list misses
        // aren't dropped just because the LLM doesn't see a comment thread.
        if (!item.worthEngaging && !isBacklinkIntent) {
          rejections.notWorthEngaging++;
          rejections.byPlatform[original.platform] =
            (rejections.byPlatform[original.platform] || 0) + 1;
          continue;
        }

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

  console.log(
    `[social-monitoring] qualified ${qualified.length}/${results.length} — rejections:`,
    rejections,
  );

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

    return parsed.filter(
      (item): item is QualificationItem =>
        typeof item.index === "number" &&
        validRelevance.has(item.relevance) &&
        VALID_INTENTS.has(item.intent) &&
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

  // Log what we're about to save by platform — if the DB CHECK constraint
  // rejects (e.g., migration not yet run), this trace makes it obvious which
  // platform was the offender rather than blowing up the whole batch
  // silently.
  const inputByPlatform: Record<string, number> = {};
  for (const m of mentions) {
    inputByPlatform[m.platform] = (inputByPlatform[m.platform] || 0) + 1;
  }
  console.log("[social-monitoring] saveMentions input:", inputByPlatform);

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
    // Surface the platform breakdown so it's easy to see which CHECK
    // constraint failed (e.g. "platform" or "intent").
    console.error(
      "[social-monitoring] saveMentions FAILED — input was:",
      inputByPlatform,
      "error:",
      error.message,
    );
    throw new Error(`Failed to save mentions: ${error.message}`);
  }

  // Log success too — without this, a successful upsert produces no log
  // entry, making it impossible to tell from logs whether save ran. We
  // already saw a case where the qualifier finished and saveMentions logged
  // its input but no follow-up appeared, leaving the question open.
  console.log(
    `[social-monitoring] saveMentions ok — inserted ${data?.length ?? 0} new rows (input was ${rows.length}; duplicates ignored)`,
  );

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
): Promise<{
  collected: number;
  qualified: number;
  saved: number;
  byPlatform: Record<string, number>;
}> {
  const collected = await collectAll();

  const byPlatform: Record<string, number> = {};
  for (const r of collected) {
    byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1;
  }
  console.log(
    `[social-monitoring] collected ${collected.length} raw — by platform:`,
    byPlatform,
  );
  // If a platform we expected to populate returned zero, surface it loudly.
  // Most common cause: upstream API quota (Exa credits exhausted, GitHub rate
  // limit, Algolia outage). Silent zeros are the worst kind of failure.
  for (const expected of [
    "reddit",
    "twitter",
    "linkedin",
    "hackernews",
    "web",
    "github",
  ]) {
    if (!byPlatform[expected]) {
      console.warn(
        `[social-monitoring] platform "${expected}" returned 0 raw results — check upstream quota / API errors`,
      );
    }
  }

  const qualified = await qualifyMentions(collected);
  const saved = await saveMentions(client, qualified);

  return {
    collected: collected.length,
    qualified: qualified.length,
    saved,
    byPlatform,
  };
}
