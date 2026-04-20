import { searchResearchPapers, searchWebContent } from "@/lib/exa";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { getCompetitorDomains } from "@/lib/voice-policy";

const WORDPRESS_API_BASE =
  process.env.WORDPRESS_API_BASE?.replace(/\/$/, "") ||
  "https://kodus.io/wp-json/wp/v2";
const CHANGELOG_API_URL = resolveChangelogApiUrl(
  process.env.CHANGELOG_API_URL?.trim() ||
    "https://changelog-generator.up.railway.app",
);
const CHANGELOG_REPOSITORY =
  process.env.CHANGELOG_REPOSITORY?.trim() || "kodustech/kodus-ai";
const CHANGELOG_LOOKBACK_DAYS = parseLookbackDays(
  process.env.CHANGELOG_LOOKBACK_DAYS,
);
const CHANGELOG_GITHUB_TOKEN = process.env.CHANGELOG_GITHUB_TOKEN?.trim();

export type FeedSource =
  | "blog"
  | "changelog"
  | "hackernews"
  | "research"
  | "competitor"
  | "reddit"
  | "all";

export type FeedItem = {
  id: string;
  title: string;
  link: string;
  excerpt: string;
  content: string;
  publishedAt?: string;
  source:
    | "blog"
    | "changelog"
    | "hackernews"
    | "research"
    | "competitor"
    | "reddit";
};

export function parseFeedSource(value: string | null): FeedSource {
  if (value === "changelog") {
    return "changelog";
  }
  if (value === "hackernews") {
    return "hackernews";
  }
  if (value === "research") {
    return "research";
  }
  if (value === "competitor") {
    return "competitor";
  }
  if (value === "reddit") {
    return "reddit";
  }
  if (value === "all") {
    return "all";
  }
  return "blog";
}

export async function fetchFeedPosts(source: FeedSource): Promise<FeedItem[]> {
  if (source === "blog") {
    return fetchWordPressPosts();
  }
  if (source === "changelog") {
    return fetchChangelogPosts();
  }
  if (source === "hackernews") {
    return fetchHackerNewsPosts();
  }
  if (source === "research") {
    return fetchResearchPapers();
  }
  if (source === "competitor") {
    return fetchCompetitorNarratives();
  }
  if (source === "reddit") {
    return fetchRedditDiscussions();
  }

  const [
    blogResult,
    changelogResult,
    hnResult,
    researchResult,
    competitorResult,
    redditResult,
  ] = await Promise.allSettled([
    fetchWordPressPosts(),
    fetchChangelogPosts(),
    fetchHackerNewsPosts(),
    fetchResearchPapers(),
    fetchCompetitorNarratives(),
    fetchRedditDiscussions(),
  ]);

  if (
    blogResult.status === "rejected" &&
    changelogResult.status === "rejected" &&
    hnResult.status === "rejected" &&
    researchResult.status === "rejected" &&
    competitorResult.status === "rejected" &&
    redditResult.status === "rejected"
  ) {
    throw blogResult.reason instanceof Error
      ? blogResult.reason
      : new Error("Could not fetch any feed sources.");
  }

  const merged = [
    ...(blogResult.status === "fulfilled" ? blogResult.value : []),
    ...(changelogResult.status === "fulfilled" ? changelogResult.value : []),
    ...(hnResult.status === "fulfilled" ? hnResult.value : []),
    ...(researchResult.status === "fulfilled" ? researchResult.value : []),
    ...(competitorResult.status === "fulfilled" ? competitorResult.value : []),
    ...(redditResult.status === "fulfilled" ? redditResult.value : []),
  ];

  return sortByPublishedAtDesc(merged);
}

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";
// Broad-ish filter: we want anything a founder in the devtools / AI coding
// space would plausibly have a take on. Keep it generous — the user can
// still skim and pick.
const HN_AI_KEYWORDS = [
  // AI / LLM
  "ai",
  "llm",
  "gpt",
  "claude",
  "gemini",
  "anthropic",
  "openai",
  "copilot",
  "cursor",
  "ai agent",
  "agentic",
  "code generation",
  "ai-assisted",
  "vibe coding",
  "mcp",
  // Engineering / devtools
  "code review",
  "pull request",
  "pr review",
  "developer",
  "engineering",
  "software engineer",
  "devtools",
  "dev tools",
  "programming",
  "startup",
  "github",
  "open source",
  "typescript",
  "javascript",
  "python",
  "rust",
  "kubernetes",
  "platform engineering",
  "sre",
  "devops",
];
const HN_MAX_RESULTS = 25;
const HN_FETCH_BATCH = 80;

async function fetchHackerNewsPosts(): Promise<FeedItem[]> {
  const topStoriesResponse = await fetch(`${HN_API_BASE}/topstories.json`, {
    cache: "no-store",
    next: { revalidate: 0 },
  });

  if (!topStoriesResponse.ok) {
    throw new Error(
      `Failed to fetch Hacker News top stories (${topStoriesResponse.status}).`,
    );
  }

  const topStoryIds: unknown = await topStoriesResponse.json();
  if (!Array.isArray(topStoryIds)) {
    return [];
  }

  const storyIds = topStoryIds.slice(0, 100) as number[];
  const items: FeedItem[] = [];

  for (let offset = 0; offset < storyIds.length; offset += HN_FETCH_BATCH) {
    if (items.length >= HN_MAX_RESULTS) break;

    const batch = storyIds.slice(offset, offset + HN_FETCH_BATCH);
    const results = await Promise.allSettled(
      batch.map((id) =>
        fetch(`${HN_API_BASE}/item/${id}.json`, {
          cache: "no-store",
          next: { revalidate: 0 },
        }).then((res) => (res.ok ? res.json() : null)),
      ),
    );

    for (const result of results) {
      if (items.length >= HN_MAX_RESULTS) break;
      if (result.status !== "fulfilled" || !result.value) continue;

      const item = normalizeHackerNewsItem(result.value);
      if (item) {
        items.push(item);
      }
    }
  }

  return items;
}

function normalizeHackerNewsItem(item: unknown): FeedItem | null {
  if (!item || typeof item !== "object") return null;

  const record = item as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;

  const titleLower = title.toLowerCase();
  const matchesAiCoding = HN_AI_KEYWORDS.some((keyword) =>
    titleLower.includes(keyword),
  );
  if (!matchesAiCoding) return null;

  const id =
    typeof record.id === "number"
      ? String(record.id)
      : typeof record.id === "string"
        ? record.id
        : null;
  if (!id) return null;

  const url =
    typeof record.url === "string" && record.url.trim().length > 0
      ? record.url.trim()
      : `https://news.ycombinator.com/item?id=${id}`;

  const text = typeof record.text === "string" ? stripHtml(record.text) : "";
  const score =
    typeof record.score === "number" ? `${record.score} points` : "";
  const descendants =
    typeof record.descendants === "number"
      ? `${record.descendants} comments`
      : "";

  const contentParts = [
    `Hacker News discussion: ${title}`,
    score && descendants ? `${score}, ${descendants}` : score || descendants,
    text,
  ].filter(Boolean);

  const content = contentParts.join("\n\n");
  const publishedAt =
    typeof record.time === "number"
      ? new Date(record.time * 1000).toISOString()
      : undefined;

  return {
    id: `hn-${id}`,
    title,
    link: url,
    excerpt: buildExcerpt(content),
    content,
    publishedAt,
    source: "hackernews",
  };
}

const RESEARCH_TOPICS = [
  "AI coding assistants and code generation tools",
  "LLM agents for software engineering",
  "developer productivity and developer experience",
  "automated code review and pull request analysis",
  "AI-assisted debugging and testing",
];
const RESEARCH_MAX_RESULTS = 10;

// Fallback competitor domains used when the admin hasn't configured any yet
// in brand_voice_profiles.competitor_domains. Used as seed for adversarial
// posts so the author pushes back on real external narratives instead of
// positioning against their own content.
const DEFAULT_COMPETITOR_DOMAINS = [
  "qodo.ai",
  "codium.ai",
  "greptile.com",
  "blog.greptile.com",
  "coderabbit.ai",
  "blog.coderabbit.ai",
  "graphite.dev",
  "graphite.com",
  "sourcegraph.com",
  "about.sourcegraph.com",
  "cursor.com",
  "cursor.sh",
  "continue.dev",
  "aider.chat",
  "sweep.dev",
  "codegen.com",
  "windsurf.com",
  "swyx.io",
  "simonwillison.net",
  "latent.space",
];

async function resolveCompetitorDomains(): Promise<string[]> {
  try {
    const configured = await getCompetitorDomains(getSupabaseServiceClient());
    if (configured.length) return configured;
  } catch (err) {
    console.warn("[feed-sources] failed to read competitor_domains:", err);
  }
  return DEFAULT_COMPETITOR_DOMAINS;
}

const COMPETITOR_QUERIES = [
  "AI code review automation future of engineering",
  "agentic code review vs human reviewer trade-offs",
  "AI pull request analysis productivity",
  "LLM code generation quality assurance",
  "developer productivity AI tools replace senior engineers",
  "AI assisted programming critique",
];

const COMPETITOR_MAX_RESULTS = 14;

// ---------------------------------------------------------------------------
// In-memory cache for expensive Exa-backed fetchers.
// HN/Blog/Changelog stay uncached: they're free public APIs and we want the
// most recent data. Reddit and competitor hit Exa credits per call, so they
// benefit from short-lived caching without loss of freshness.
// ---------------------------------------------------------------------------
const FEED_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

type FeedCacheEntry = {
  expiresAt: number;
  data: FeedItem[];
};

const feedCache = new Map<string, FeedCacheEntry>();

async function cachedFeed(
  cacheKey: string,
  fetcher: () => Promise<FeedItem[]>,
): Promise<FeedItem[]> {
  const now = Date.now();
  const hit = feedCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return hit.data;
  }

  const data = await fetcher();
  feedCache.set(cacheKey, {
    data,
    expiresAt: now + FEED_CACHE_TTL_MS,
  });
  return data;
}

async function fetchCompetitorNarratives(): Promise<FeedItem[]> {
  const domains = await resolveCompetitorDomains();
  // Cache key includes a stable hash of the configured domains so changing
  // them in /settings invalidates without needing a server restart.
  const cacheKey = `competitor:${[...domains].sort().join(",")}`;
  return cachedFeed(cacheKey, () => fetchCompetitorNarrativesUncached(domains));
}

async function fetchCompetitorNarrativesUncached(
  domains: string[],
): Promise<FeedItem[]> {
  // First pass: strict includeDomains. Exa only returns URLs from the listed
  // domains, which is the precise signal we want but often comes back empty
  // when the competitor's blog lives on a subdomain we did not list, or when
  // Exa's index doesn't have that domain well-covered.
  const strictResponses = await Promise.allSettled(
    COMPETITOR_QUERIES.map((query) =>
      searchWebContent({
        query,
        domains,
        numResults: 4,
        daysBack: 120,
        textMaxCharacters: 800,
      }),
    ),
  );

  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const response of strictResponses) {
    if (response.status !== "fulfilled") continue;
    for (const hit of response.value.results) {
      if (!hit.url || seen.has(hit.url)) continue;
      seen.add(hit.url);

      const excerpt = hit.summary || hit.highlights[0] || "";
      const contentParts = [hit.summary, hit.text].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );

      items.push({
        id: hit.id,
        title: hit.title,
        link: hit.url,
        excerpt,
        content: contentParts.join("\n\n") || hit.title,
        publishedAt: hit.publishedDate ?? undefined,
        source: "competitor" as const,
      });
    }
  }

  // Fallback: strict search found nothing. Run the same queries as a broad
  // web search excluding our own domain so we at least surface competing
  // narratives in the space. Results are less precise but better than zero.
  if (!items.length) {
    const fallbackResponses = await Promise.allSettled(
      COMPETITOR_QUERIES.map((query) =>
        searchWebContent({
          query,
          excludeDomains: ["kodus.io"],
          numResults: 4,
          daysBack: 120,
          textMaxCharacters: 800,
        }),
      ),
    );
    for (const response of fallbackResponses) {
      if (response.status !== "fulfilled") continue;
      for (const hit of response.value.results) {
        if (!hit.url || seen.has(hit.url)) continue;
        // Skip obviously generic pages (docs, login, home)
        if (/\/(login|signup|pricing|privacy|terms)\b/i.test(hit.url)) continue;
        seen.add(hit.url);

        const excerpt = hit.summary || hit.highlights[0] || "";
        const contentParts = [hit.summary, hit.text].filter(
          (part): part is string => typeof part === "string" && part.length > 0,
        );

        items.push({
          id: hit.id,
          title: hit.title,
          link: hit.url,
          excerpt,
          content: contentParts.join("\n\n") || hit.title,
          publishedAt: hit.publishedDate ?? undefined,
          source: "competitor" as const,
        });
      }
    }
  }

  return sortByPublishedAtDesc(items).slice(0, COMPETITOR_MAX_RESULTS);
}

// Reddit discussions pulled via Exa semantic search on dev-focused subreddits.
// Great signal for Bubble / Hot Takes lanes: devs complain, debate, and share
// experiences in ways Twitter and HN don't always capture.
const REDDIT_SUBREDDIT_DOMAINS = [
  "reddit.com/r/ExperiencedDevs",
  "reddit.com/r/programming",
  "reddit.com/r/cscareerquestions",
  "reddit.com/r/devops",
  "reddit.com/r/webdev",
  "reddit.com/r/MachineLearning",
  "reddit.com/r/LocalLLaMA",
  "reddit.com/r/LLMDevs",
  "reddit.com/r/ClaudeAI",
  "reddit.com/r/ChatGPTCoding",
];

const REDDIT_QUERIES = [
  "AI code review experience developers",
  "pull request workflow complaints",
  "AI coding assistant productivity discussion",
  "LLM in software engineering debate",
  "senior engineer AI tools opinion",
  "agentic coding devex reality",
];

const REDDIT_MAX_RESULTS = 14;

async function fetchRedditDiscussions(): Promise<FeedItem[]> {
  return cachedFeed("reddit", fetchRedditDiscussionsUncached);
}

async function fetchRedditDiscussionsUncached(): Promise<FeedItem[]> {
  const responses = await Promise.allSettled(
    REDDIT_QUERIES.map((query) =>
      searchWebContent({
        query,
        domains: ["reddit.com"],
        numResults: 3,
        daysBack: 60,
        textMaxCharacters: 900,
      }),
    ),
  );

  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const response of responses) {
    if (response.status !== "fulfilled") continue;
    for (const hit of response.value.results) {
      if (!hit.url || seen.has(hit.url)) continue;
      // Reddit returns a lot of cross-posts and sidebars; keep only comment
      // threads (URLs containing /comments/ are real discussions).
      if (!/reddit\.com\/r\/[^/]+\/comments\//i.test(hit.url)) continue;
      seen.add(hit.url);

      const excerpt = hit.summary || hit.highlights[0] || "";
      const contentParts = [hit.summary, hit.text].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );
      const subredditMatch = hit.url.match(/reddit\.com\/r\/([^/]+)\//);
      const subreddit = subredditMatch ? `r/${subredditMatch[1]}` : "Reddit";

      items.push({
        id: hit.id,
        title: `[${subreddit}] ${hit.title}`,
        link: hit.url,
        excerpt,
        content: contentParts.join("\n\n") || hit.title,
        publishedAt: hit.publishedDate ?? undefined,
        source: "reddit" as const,
      });
    }
  }

  return sortByPublishedAtDesc(items).slice(0, REDDIT_MAX_RESULTS);
}

// Silence subreddit list if unused (kept for future broadening)
void REDDIT_SUBREDDIT_DOMAINS;

async function fetchResearchPapers(): Promise<FeedItem[]> {
  const { results } = await searchResearchPapers({
    topics: RESEARCH_TOPICS,
    numResultsPerTopic: 3,
    daysBack: 90,
  });

  return results.slice(0, RESEARCH_MAX_RESULTS).map((paper, index) => {
    const contentParts = [
      paper.summary,
      paper.highlights.length
        ? `Key findings: ${paper.highlights.join(" | ")}`
        : "",
    ].filter(Boolean);

    return {
      id: `research-${index}-${paper.id}`,
      title: paper.title,
      link: paper.url,
      excerpt: paper.summary || paper.title,
      content: contentParts.join("\n\n") || paper.title,
      publishedAt: paper.publishedDate ?? undefined,
      source: "research" as const,
    };
  });
}

async function fetchWordPressPosts(): Promise<FeedItem[]> {
  const endpoint = new URL(`${WORDPRESS_API_BASE}/posts`);
  endpoint.searchParams.set("per_page", "100");
  endpoint.searchParams.set("orderby", "date");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set(
    "_fields",
    "id,title.rendered,link,date,content.rendered,excerpt.rendered",
  );

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    const body = await safeReadJson(response);
    throw new Error(
      `Failed to fetch posts (${response.status}). ${
        body?.message || "Try again."
      }`,
    );
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((item) => normalizeWordPressItem(item))
    .filter((item): item is FeedItem => Boolean(item));
}

async function fetchChangelogPosts(): Promise<FeedItem[]> {
  const { owner, repo } = parseRepository(CHANGELOG_REPOSITORY);
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - CHANGELOG_LOOKBACK_DAYS);

  const payload: Record<string, unknown> = {
    owner,
    repo,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
    filter: "all",
    format: "json",
    style: "developer",
  };

  if (CHANGELOG_GITHUB_TOKEN) {
    payload.token = CHANGELOG_GITHUB_TOKEN;
  }

  const response = await fetch(CHANGELOG_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    const body = await safeReadJson(response);
    throw new Error(
      `Failed to fetch changelog ideas (${response.status}). ${
        body?.error || body?.message || "Try again."
      }`,
    );
  }

  const data = await response.json();
  const repositoryLink = `https://github.com/${owner}/${repo}`;

  const posts = normalizeChangelogResult(data?.changelog, repositoryLink);
  return sortByPublishedAtDesc(posts).slice(0, 30);
}

function normalizeWordPressItem(item: unknown): FeedItem | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const idValue = record.id;
  const id =
    typeof idValue === "number"
      ? String(idValue)
      : typeof idValue === "string"
        ? idValue
        : null;

  const title = stripHtml(getRendered(record.title)) || "";
  const link =
    typeof record.link === "string" && record.link.trim().length > 0
      ? record.link.trim()
      : "";

  if (!id || !title || !link) {
    return null;
  }

  const contentHtml = getRendered(record.content);
  const excerptHtml = getRendered(record.excerpt);
  const content = stripHtml(contentHtml) || stripHtml(excerptHtml);
  const excerpt =
    stripHtml(excerptHtml) || (content ? buildExcerpt(content) : "");

  return {
    id,
    title,
    link,
    content,
    excerpt,
    publishedAt:
      typeof record.date === "string" ? safeIsoDate(record.date) : undefined,
    source: "blog",
  };
}

function normalizeChangelogResult(
  changelog: unknown,
  repositoryLink: string,
): FeedItem[] {
  if (!changelog) {
    return [];
  }

  if (typeof changelog === "string") {
    return normalizeMarkdownChangelog(changelog, repositoryLink);
  }

  if (typeof changelog !== "object" || Array.isArray(changelog)) {
    return [];
  }

  const posts: FeedItem[] = [];
  const categories = changelog as Record<string, unknown>;

  for (const [category, value] of Object.entries(categories)) {
    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      const post = normalizeChangelogPullRequest(item, category, repositoryLink);
      if (post) {
        posts.push(post);
      }
    }
  }

  return posts;
}

function normalizeChangelogPullRequest(
  item: unknown,
  category: string,
  repositoryLink: string,
): FeedItem | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const title = cleanText(record.title);
  if (!title) {
    return null;
  }

  const numberValue = Number(record.number);
  const number =
    Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
  const categoryLabel = formatCategoryLabel(category);
  const body = cleanText(record.body);
  const labels = Array.isArray(record.labels)
    ? record.labels
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];

  const link =
    typeof record.html_url === "string" && record.html_url.trim().length > 0
      ? record.html_url.trim()
      : number
        ? `${repositoryLink}/pull/${number}`
        : repositoryLink;

  const contentSections = [
    `Repository update from ${repositoryLink.replace("https://github.com/", "")}.`,
    `Category: ${categoryLabel}.`,
    number ? `Pull request #${number}.` : "",
    body,
    labels.length ? `Labels: ${labels.join(", ")}.` : "",
  ].filter(Boolean);

  return {
    id: number ? `changelog-${number}` : `changelog-${category}-${title}`,
    title: `${categoryLabel}: ${title}`,
    link,
    excerpt: body ? buildExcerpt(body) : buildExcerpt(title),
    content: contentSections.join("\n\n"),
    publishedAt:
      typeof record.merged_at === "string" ? safeIsoDate(record.merged_at) : undefined,
    source: "changelog",
  };
}

function normalizeMarkdownChangelog(
  markdown: string,
  repositoryLink: string,
): FeedItem[] {
  const lines = markdown.split(/\r?\n/);
  const posts: FeedItem[] = [];
  let section = "Changelog";
  let index = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const headingMatch = /^#{2,}\s+(.+)$/.exec(line);
    if (headingMatch) {
      section = cleanText(headingMatch[1]) || section;
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    if (!bulletMatch) {
      continue;
    }

    const text = cleanText(stripMarkdownLinks(bulletMatch[1]));
    if (!text) {
      continue;
    }

    index += 1;
    posts.push({
      id: `changelog-md-${index}`,
      title: `${section}: ${text.slice(0, 110)}`,
      link: repositoryLink,
      excerpt: buildExcerpt(text),
      content: `Category: ${section}.\n\n${text}`,
      source: "changelog",
    });
  }

  return posts;
}

function getRendered(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.rendered === "string") {
      return record.rendered;
    }
  }
  return "";
}

function stripHtml(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const withBreaks = value
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return withBreaks
    .replace(/<[^>]*>/g, " ")
    .replace(/\r?\n\s*/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function buildExcerpt(value: string, maxLength = 260): string {
  if (!value) return "";
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trim()}...`;
}

async function safeReadJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function safeIsoDate(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function resolveChangelogApiUrl(rawValue: string): string {
  const normalized = rawValue.replace(/\/$/, "");
  if (normalized.endsWith("/api/v1/changelog")) {
    return normalized;
  }
  return `${normalized}/api/v1/changelog`;
}

function parseRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/").map((value) => value.trim());
  if (!owner || !repo) {
    throw new Error(
      `Invalid CHANGELOG_REPOSITORY "${repository}". Expected "owner/repo".`,
    );
  }
  return { owner, repo };
}

function parseLookbackDays(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 30;
  }
  return Math.max(1, Math.min(365, Math.round(parsed)));
}

function formatCategoryLabel(value: string): string {
  if (!value) {
    return "Updates";
  }

  const normalized = value.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!normalized) {
    return "Updates";
  }

  return normalized
    .split(/[\s_-]+/)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\r?\n\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripMarkdownLinks(value: string): string {
  return value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function sortByPublishedAtDesc(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });
}
