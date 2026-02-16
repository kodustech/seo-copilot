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
    label: "Dores",
    queryTemplate: (topic) =>
      `developers and teams struggling with ${topic}, common frustrations, problems people face`,
  },
  questions: {
    label: "Perguntas",
    queryTemplate: (topic) =>
      `how to get started with ${topic}, best way to implement ${topic}, common questions about ${topic}`,
  },
  trends: {
    label: "Tendências",
    queryTemplate: (topic) =>
      `new tools and announcements in ${topic}, latest trends and what's changing in ${topic}`,
  },
  comparisons: {
    label: "Comparações",
    queryTemplate: (topic) =>
      `${topic} comparison, alternatives, versus, which one should I choose for ${topic}`,
  },
  best_practices: {
    label: "Boas Práticas",
    queryTemplate: (topic) =>
      `${topic} best practices, lessons learned, tips from experience, production ${topic} guide`,
  },
};

const SUMMARY_PROMPT =
  "What is the main pain point, question, or insight discussed? Why would this be relevant for creating a blog article? Be specific and actionable in 2-3 sentences.";

const HIGHLIGHTS_PROMPT =
  "Extract the most interesting quotes, data points, or specific claims that could inspire a blog article.";

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function searchIdeas({
  topic,
  domains,
  numResultsPerAngle = 8,
  daysBack = 90,
}: SearchIdeasInput): Promise<SearchIdeasOutput> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "EXA_API_KEY nao configurada. Adicione a variavel de ambiente para usar a pesquisa de ideias.",
    );
  }

  const exa = new Exa(apiKey);
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
