import Exa from "exa-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IdeaAngle =
  | "pain_points"
  | "questions"
  | "trends"
  | "comparisons"
  | "best_practices";

export type IdeaResult = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedDate: string | null;
  summary: string | null;
  highlights: string[];
  angle: IdeaAngle;
  angleLabel: string;
  score: number | null;
};

export type SearchIdeasInput = {
  topic: string;
  domains?: string[];
  numResultsPerAngle?: number;
  daysBack?: number;
};

export type SearchIdeasOutput = {
  results: IdeaResult[];
  topic: string;
};

export type WebSearchResult = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedDate: string | null;
  summary: string | null;
  highlights: string[];
  text: string | null;
  score: number | null;
};

export type SearchWebInput = {
  query: string;
  domains?: string[];
  excludeDomains?: string[];
  numResults?: number;
  daysBack?: number;
  textMaxCharacters?: number;
};

export type SearchWebOutput = {
  query: string;
  results: WebSearchResult[];
};

export type LivecrawlMode =
  | "never"
  | "fallback"
  | "always"
  | "auto"
  | "preferred";

export type ScrapePageInput = {
  url: string;
  maxCharacters?: number;
  includeSummary?: boolean;
  includeHighlights?: boolean;
  livecrawl?: LivecrawlMode;
};

export type ScrapePageOutput = {
  url: string;
  title: string | null;
  source: string;
  publishedDate: string | null;
  summary: string | null;
  highlights: string[];
  text: string | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DOMAINS = [
  "reddit.com",
  "dev.to",
  "news.ycombinator.com",
  "stackoverflow.com",
  "x.com",
  "medium.com",
  "hashnode.dev",
  "linkedin.com",
];

const ANGLE_CONFIG: Record<
  IdeaAngle,
  { label: string; queryTemplate: (topic: string) => string }
> = {
  pain_points: {
    label: "Pain Points",
    queryTemplate: (topic) =>
      `developers and teams struggling with ${topic}, common frustrations, problems people face`,
  },
  questions: {
    label: "Questions",
    queryTemplate: (topic) =>
      `how to get started with ${topic}, best way to implement ${topic}, common questions about ${topic}`,
  },
  trends: {
    label: "Trends",
    queryTemplate: (topic) =>
      `new tools and announcements in ${topic}, latest trends and what's changing in ${topic}`,
  },
  comparisons: {
    label: "Comparisons",
    queryTemplate: (topic) =>
      `${topic} comparison, alternatives, versus, which one should I choose for ${topic}`,
  },
  best_practices: {
    label: "Best Practices",
    queryTemplate: (topic) =>
      `${topic} best practices, lessons learned, tips from experience, production ${topic} guide`,
  },
};

const SUMMARY_PROMPT =
  "What is the main pain point, question, or insight discussed? Why would this be relevant for creating a blog article? Be specific and actionable in 2-3 sentences.";

const HIGHLIGHTS_PROMPT =
  "Extract the most interesting quotes, data points, or specific claims that could inspire a blog article.";

const GENERIC_SUMMARY_PROMPT =
  "Summarize the key points of this page in 2-3 concise sentences, preserving concrete details.";

const GENERIC_HIGHLIGHTS_PROMPT =
  "Extract the most important facts, claims, and actionable takeaways from this page.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSource(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (hostname.includes("reddit.com")) return "Reddit";
    if (hostname.includes("dev.to")) return "dev.to";
    if (hostname.includes("ycombinator.com")) return "HackerNews";
    if (hostname.includes("stackoverflow.com")) return "StackOverflow";
    if (hostname.includes("x.com") || hostname.includes("twitter.com"))
      return "Twitter";
    if (hostname.includes("medium.com")) return "Medium";
    if (hostname.includes("hashnode")) return "Hashnode";
    if (hostname.includes("linkedin.com")) return "LinkedIn";
    return hostname;
  } catch {
    return "web";
  }
}

function makeStartDate(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split("T")[0];
}

function isQualityResult(r: {
  title: string | null;
  summary: string | null;
}): boolean {
  if (!r.title || r.title.length < 10) return false;
  if (!r.summary || r.summary.length < 30) return false;
  // Filter generic/useless titles
  const generic = [
    "home",
    "index",
    "untitled",
    "404",
    "page not found",
    "sign in",
    "login",
  ];
  const lower = r.title.toLowerCase();
  if (generic.some((g) => lower === g)) return false;
  return true;
}

function createExaClient(featureName: string): Exa {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `EXA_API_KEY is not configured. Add the environment variable to use ${featureName}.`,
    );
  }
  return new Exa(apiKey);
}

// ---------------------------------------------------------------------------
// Competitor Analysis
// ---------------------------------------------------------------------------

export type CompetitorResult = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedDate: string | null;
  summary: string | null;
  highlights: string[];
};

export type CompetitorAnalysisOutput = {
  topic: string;
  results: CompetitorResult[];
};

const COMPETITOR_SUMMARY_PROMPT =
  "What is this article about? What angle, structure, and unique value does it provide? Summarize in 2-3 actionable sentences for someone who wants to write a better competing article.";

const COMPETITOR_HIGHLIGHTS_PROMPT =
  "Extract the most important data points, claims, frameworks, or unique insights that make this content stand out.";

export async function searchCompetitorContent({
  topic,
  excludeDomains = ["kodus.io"],
  targetDomains,
  numResults = 10,
  daysBack = 180,
}: {
  topic: string;
  excludeDomains?: string[];
  targetDomains?: string[];
  numResults?: number;
  daysBack?: number;
}): Promise<CompetitorAnalysisOutput> {
  const exa = createExaClient("competitor analysis");
  const startPublishedDate = makeStartDate(daysBack);

  const response = await exa.searchAndContents(
    `best article about ${topic}, comprehensive guide, in-depth analysis`,
    {
      type: "auto",
      numResults,
      startPublishedDate,
      useAutoprompt: true,
      ...(targetDomains?.length ? { includeDomains: targetDomains } : {}),
      ...(excludeDomains?.length ? { excludeDomains: excludeDomains } : {}),
      highlights: {
        query: COMPETITOR_HIGHLIGHTS_PROMPT,
        maxCharacters: 300,
      },
      summary: {
        query: COMPETITOR_SUMMARY_PROMPT,
      },
    },
  );

  const results: CompetitorResult[] = (response.results ?? []).map(
    (r): CompetitorResult => ({
      id: r.id ?? r.url,
      title: r.title ?? "Untitled",
      url: r.url,
      source: extractSource(r.url),
      publishedDate: r.publishedDate ?? null,
      summary: r.summary ?? null,
      highlights: r.highlights ?? [],
    }),
  );

  // Filter low quality
  const quality = results.filter(
    (r) => r.title.length >= 10 && r.summary && r.summary.length >= 30,
  );

  return { topic, results: quality };
}

// ---------------------------------------------------------------------------
// Ideas Search
// ---------------------------------------------------------------------------

export async function searchIdeas({
  topic,
  domains,
  numResultsPerAngle = 8,
  daysBack = 90,
}: SearchIdeasInput): Promise<SearchIdeasOutput> {
  const exa = createExaClient("idea research");
  const includeDomains = domains?.length ? domains : DEFAULT_DOMAINS;
  const startPublishedDate = makeStartDate(daysBack);

  const angles = Object.entries(ANGLE_CONFIG) as [
    IdeaAngle,
    (typeof ANGLE_CONFIG)[IdeaAngle],
  ][];

  const searches = angles.map(async ([angle, config]) => {
    try {
      const response = await exa.searchAndContents(
        config.queryTemplate(topic),
        {
          type: "auto",
          numResults: numResultsPerAngle,
          includeDomains,
          startPublishedDate,
          useAutoprompt: true,
          highlights: {
            query: HIGHLIGHTS_PROMPT,
            maxCharacters: 300,
          },
          summary: {
            query: SUMMARY_PROMPT,
          },
        },
      );

      return (response.results ?? []).map(
        (r): IdeaResult => ({
          id: r.id ?? r.url,
          title: r.title ?? "Sem titulo",
          url: r.url,
          source: extractSource(r.url),
          publishedDate: r.publishedDate ?? null,
          summary: r.summary ?? null,
          highlights: r.highlights ?? [],
          angle,
          angleLabel: config.label,
          score: r.score ?? null,
        }),
      );
    } catch {
      return [] as IdeaResult[];
    }
  });

  const perAngle = await Promise.all(searches);
  const all = perAngle.flat();

  // Dedup by URL
  const seen = new Set<string>();
  const deduped = all.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  // Filter low-quality results
  const quality = deduped.filter((r) => isQualityResult(r));

  // Sort by score (higher = more relevant)
  quality.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return { results: quality, topic };
}

// ---------------------------------------------------------------------------
// Generic Search + Page Scraping
// ---------------------------------------------------------------------------

export async function searchWebContent({
  query,
  domains,
  excludeDomains,
  numResults = 10,
  daysBack = 365,
  textMaxCharacters = 4000,
}: SearchWebInput): Promise<SearchWebOutput> {
  const exa = createExaClient("generic web search");

  const response = await exa.searchAndContents(query, {
    type: "auto",
    numResults,
    ...(domains?.length ? { includeDomains: domains } : {}),
    ...(excludeDomains?.length ? { excludeDomains } : {}),
    ...(typeof daysBack === "number" ? { startPublishedDate: makeStartDate(daysBack) } : {}),
    useAutoprompt: true,
    text: { maxCharacters: textMaxCharacters },
    highlights: {
      query: GENERIC_HIGHLIGHTS_PROMPT,
      maxCharacters: 320,
    },
    summary: {
      query: GENERIC_SUMMARY_PROMPT,
    },
  });

  const mapped = (response.results ?? []).reduce<WebSearchResult[]>((acc, r) => {
    if (!r.url) return acc;
    acc.push({
      id: r.id ?? r.url,
      title: r.title ?? "Untitled",
      url: r.url,
      source: extractSource(r.url),
      publishedDate: r.publishedDate ?? null,
      summary: typeof r.summary === "string" ? r.summary : null,
      highlights: Array.isArray(r.highlights) ? r.highlights : [],
      text: typeof r.text === "string" ? r.text : null,
      score: r.score ?? null,
    });
    return acc;
  }, []);

  const seen = new Set<string>();
  const deduped = mapped.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  deduped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return { query, results: deduped };
}

export async function scrapePageContent({
  url,
  maxCharacters = 8000,
  includeSummary = true,
  includeHighlights = true,
  livecrawl = "fallback",
}: ScrapePageInput): Promise<ScrapePageOutput> {
  const exa = createExaClient("page scraping");

  const response = await exa.getContents([url], {
    text: { maxCharacters },
    ...(includeHighlights
      ? {
          highlights: {
            query: GENERIC_HIGHLIGHTS_PROMPT,
            maxCharacters: 320,
          },
        }
      : {}),
    ...(includeSummary
      ? {
          summary: {
            query: GENERIC_SUMMARY_PROMPT,
          },
        }
      : {}),
    livecrawl,
  });

  const page = response.results?.find((r) => r.url === url) ?? response.results?.[0];
  if (!page || !page.url) {
    throw new Error("Could not scrape content for this URL.");
  }

  const pageRecord = page as Record<string, unknown>;
  const summaryValue = pageRecord.summary;
  const highlightsValue = pageRecord.highlights;

  return {
    url: page.url,
    title: page.title ?? null,
    source: extractSource(page.url),
    publishedDate: page.publishedDate ?? null,
    summary: typeof summaryValue === "string" ? summaryValue : null,
    highlights: Array.isArray(highlightsValue) ? (highlightsValue as string[]) : [],
    text: typeof page.text === "string" ? page.text : null,
  };
}
