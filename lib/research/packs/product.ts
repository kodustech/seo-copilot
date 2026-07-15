import type { PackOutput } from "@/lib/research/types";
import { scrapePageContent } from "@/lib/exa";

const PATHS = [
  "",
  "/pricing",
  "/product",
  "/products",
  "/platform",
  "/security",
  "/customers",
  "/solutions",
  "/features",
  "/integrations",
];

export async function runProductPack(input: {
  domain: string | null;
}): Promise<PackOutput> {
  const pack = "product";
  if (!input.domain) {
    return { pack, ok: true, snippets: [], meta: { skipped: "no_domain" } };
  }

  if (!process.env.EXA_API_KEY?.trim()) {
    return {
      pack,
      ok: false,
      error: "EXA_API_KEY not configured",
      snippets: [],
    };
  }

  const domain = input.domain.replace(/^www\./, "");
  const urls = PATHS.map((p) => `https://${domain}${p}`);

  try {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const page = await scrapePageContent({
            url,
            maxCharacters: 5000,
            includeSummary: true,
            includeHighlights: false,
            livecrawl: "fallback",
          });
          if (!page.text || page.text.length < 80) return null;
          return {
            url: page.url,
            title: page.title,
            text: `${page.summary ?? ""}\n${page.text}`.slice(0, 4500),
          };
        } catch {
          return null;
        }
      }),
    );

    const snippets = results.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );

    return {
      pack,
      ok: true,
      snippets: snippets.slice(0, 6),
      meta: { pagesScraped: snippets.length },
    };
  } catch (err) {
    return {
      pack,
      ok: false,
      error: err instanceof Error ? err.message : "product pack failed",
      snippets: [],
    };
  }
}
