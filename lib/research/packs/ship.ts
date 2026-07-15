import type { PackOutput } from "@/lib/research/types";
import { scrapePageContent, searchWebContent } from "@/lib/exa";

export async function runShipPack(input: {
  companyName: string;
  domain: string | null;
}): Promise<PackOutput> {
  const pack = "ship";
  const snippets: PackOutput["snippets"] = [];

  if (!process.env.EXA_API_KEY?.trim()) {
    return {
      pack,
      ok: false,
      error: "EXA_API_KEY not configured",
      snippets: [],
    };
  }

  try {
    if (input.domain) {
      const domain = input.domain.replace(/^www\./, "");
      for (const path of ["/changelog", "/blog", "/whats-new", "/releases"]) {
        try {
          const page = await scrapePageContent({
            url: `https://${domain}${path}`,
            maxCharacters: 4000,
            includeSummary: true,
            includeHighlights: false,
          });
          if (page.text && page.text.length > 100) {
            snippets.push({
              url: page.url,
              title: page.title,
              text: `${page.summary ?? ""}\n${page.text}`.slice(0, 3500),
            });
          }
        } catch {
          // path missing — fine
        }
      }
    }

    const q = `"${input.companyName}" (changelog OR "what's new" OR shipped OR launched OR "now available" OR release)`;
    try {
      const web = await searchWebContent({
        query: q,
        numResults: 5,
        daysBack: 365,
        textMaxCharacters: 2000,
      });
      for (const r of web.results) {
        snippets.push({
          url: r.url,
          title: r.title,
          text: [r.summary, ...(r.highlights ?? []), r.text]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2500),
        });
      }
    } catch (err) {
      console.warn("[research/ship] web search failed:", err);
    }

    return {
      pack,
      ok: true,
      snippets: snippets.slice(0, 8),
      meta: { count: snippets.length },
    };
  } catch (err) {
    return {
      pack,
      ok: false,
      error: err instanceof Error ? err.message : "ship pack failed",
      snippets,
    };
  }
}
