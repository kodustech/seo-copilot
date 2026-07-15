import type { PackOutput } from "@/lib/research/types";
import { searchWebContent } from "@/lib/exa";

function queries(name: string, domain: string | null): string[] {
  const d = domain ? ` OR site:${domain}` : "";
  return [
    `"${name}" (Series A OR Series B OR funding OR raised OR "seed round")`,
    `"${name}" (enterprise OR "SOC 2" OR SOC2 OR HIPAA OR GDPR OR compliance)${d}`,
    `"${name}" (launch OR launched OR redesign OR migration OR rearchitecture)${d}`,
    `"${name}" (SDET OR "QA Automation" OR Playwright OR Cypress OR "test suite" OR flaky)`,
    `"${name}" (AI OR LLM OR copilot OR "machine learning") (product OR customers OR production)`,
  ];
}

export async function runNewsPack(input: {
  companyName: string;
  domain: string | null;
}): Promise<PackOutput> {
  const pack = "news";

  if (!process.env.EXA_API_KEY?.trim()) {
    return {
      pack,
      ok: false,
      error: "EXA_API_KEY not configured",
      snippets: [],
    };
  }

  try {
    const all = await Promise.all(
      queries(input.companyName, input.domain).map(async (query) => {
        try {
          const res = await searchWebContent({
            query,
            numResults: 4,
            daysBack: 540,
            textMaxCharacters: 1800,
          });
          return res.results;
        } catch {
          return [];
        }
      }),
    );

    const seen = new Set<string>();
    const snippets: PackOutput["snippets"] = [];
    for (const batch of all) {
      for (const r of batch) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        snippets.push({
          url: r.url,
          title: r.title,
          text: [r.summary, ...(r.highlights ?? []), r.text]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2500),
        });
      }
    }

    return {
      pack,
      ok: true,
      snippets: snippets.slice(0, 12),
      meta: { count: snippets.length },
    };
  } catch (err) {
    return {
      pack,
      ok: false,
      error: err instanceof Error ? err.message : "news pack failed",
      snippets: [],
    };
  }
}
