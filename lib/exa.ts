import Exa from "exa-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IdeaAngle = "pain_points" | "questions" | "trends";

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
];

const ANGLE_CONFIG: Record<
  IdeaAngle,
  { label: string; querySuffix: string }
> = {
  pain_points: {
    label: "Dores",
    querySuffix: "struggling OR frustrated OR problem OR issue",
  },
  questions: {
    label: "Perguntas",
    querySuffix: "how to OR best way OR should I OR recommend",
  },
  trends: {
    label: "Tendencias",
    querySuffix: "announcement OR release OR new OR trending",
  },
};

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function searchIdeas({
  topic,
  domains,
  numResultsPerAngle = 5,
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
        `"${topic}" ${config.querySuffix}`,
        {
          type: "neural",
          numResults: numResultsPerAngle,
          includeDomains,
          startPublishedDate,
          highlights: true,
          summary: true,
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

  return { results: deduped, topic };
}
