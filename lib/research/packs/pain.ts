import type { PackOutput } from "@/lib/research/types";
import { searchWebContent } from "@/lib/exa";

export async function runPainPack(input: {
  companyName: string;
  domain: string | null;
}): Promise<PackOutput> {
  const pack = "pain";

  if (!process.env.EXA_API_KEY?.trim()) {
    return {
      pack,
      ok: false,
      error: "EXA_API_KEY not configured",
      snippets: [],
    };
  }

  const qs = [
    `"${input.companyName}" (outage OR downtime OR incident OR "status page")`,
    `"${input.companyName}" (bug OR bugs OR "doesn't work" OR broken OR flaky)`,
    input.domain
      ? `site:status.${input.domain.replace(/^www\./, "")} OR "${input.companyName}" status`
      : `"${input.companyName}" status incident`,
  ];

  try {
    const batches = await Promise.all(
      qs.map(async (query) => {
        try {
          const res = await searchWebContent({
            query,
            numResults: 4,
            daysBack: 730,
            textMaxCharacters: 1500,
          });
          return res.results;
        } catch {
          return [];
        }
      }),
    );

    const seen = new Set<string>();
    const snippets: PackOutput["snippets"] = [];
    for (const batch of batches) {
      for (const r of batch) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        snippets.push({
          url: r.url,
          title: r.title,
          text: [r.summary, ...(r.highlights ?? []), r.text]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2000),
        });
      }
    }

    return {
      pack,
      ok: true,
      snippets: snippets.slice(0, 10),
      meta: { count: snippets.length },
    };
  } catch (err) {
    return {
      pack,
      ok: false,
      error: err instanceof Error ? err.message : "pain pack failed",
      snippets: [],
    };
  }
}
