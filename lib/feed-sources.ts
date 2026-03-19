import { searchResearchPapers } from "@/lib/exa";

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

export type FeedSource = "blog" | "changelog" | "hackernews" | "research" | "all";

export type FeedItem = {
  id: string;
  title: string;
  link: string;
  excerpt: string;
  content: string;
  publishedAt?: string;
  source: "blog" | "changelog" | "hackernews" | "research";
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

  const [blogResult, changelogResult, hnResult, researchResult] = await Promise.allSettled([
    fetchWordPressPosts(),
    fetchChangelogPosts(),
    fetchHackerNewsPosts(),
    fetchResearchPapers(),
  ]);

  if (
    blogResult.status === "rejected" &&
    changelogResult.status === "rejected" &&
    hnResult.status === "rejected" &&
    researchResult.status === "rejected"
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
  ];

  return sortByPublishedAtDesc(merged);
}

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";
const HN_AI_KEYWORDS = [
  "ai coding",
  "copilot",
  "llm",
  "ai agent",
  "code generation",
  "ai programming",
  "cursor",
  "claude",
  "gpt",
  "ai-assisted",
  "vibe coding",
  "agentic",
];
const HN_MAX_RESULTS = 15;
const HN_FETCH_BATCH = 30;

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
