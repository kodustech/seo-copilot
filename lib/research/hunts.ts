// Signal-hunt executor: the ICP compiler decides WHERE each trigger signal
// lives (job postings, news, incidents, generic web); this module runs those
// hunts. Each hunt: search the right source → read the found pages → one
// batched LLM call confirms the signal and extracts the company + a quote.
// Confirmed candidates enter the table with evidence attached, so the rubric
// criterion the hunt maps to is already proven — full research then only has
// to settle fit and anti criteria.

import { generateText } from "ai";

import { getModel } from "@/lib/ai/provider";
import { searchWebContent } from "@/lib/exa";
import type { HuntSource, IcpHunt } from "@/lib/research/icp-plan";

export type HuntCandidate = {
  companyName: string;
  domain: string | null;
  source: HuntSource;
  criterionId: string;
  query: string;
  url: string;
  title: string | null;
  /** Verbatim-ish quote from the page proving the signal. */
  quote: string;
  confidence: number;
};

// Where each source type searches. job_postings scopes to public ATS job
// pages; the rest search the open web with the query carrying the intent.
const SOURCE_DOMAINS: Record<HuntSource, string[] | undefined> = {
  job_postings: [
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
    "apply.workable.com",
    "jobs.smartrecruiters.com",
    "gupy.io",
    "programathor.com.br",
  ],
  news: undefined,
  incidents: undefined,
  web: undefined,
};

const SOURCE_DAYS_BACK: Record<HuntSource, number> = {
  job_postings: 90,
  news: 180,
  incidents: 365,
  web: 365,
};

type PageHit = {
  url: string;
  title: string | null;
  text: string;
  query: string;
};

async function searchHunt(
  hunt: IcpHunt,
  resultsPerQuery: number,
): Promise<PageHit[]> {
  const seen = new Set<string>();
  const hits: PageHit[] = [];
  for (const query of hunt.queries) {
    try {
      const res = await searchWebContent({
        query,
        numResults: resultsPerQuery,
        daysBack: SOURCE_DAYS_BACK[hunt.source],
        textMaxCharacters: 2200,
        ...(SOURCE_DOMAINS[hunt.source]
          ? { domains: SOURCE_DOMAINS[hunt.source] }
          : {}),
      });
      for (const r of res.results) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        hits.push({
          url: r.url,
          title: r.title,
          text: [r.summary, ...(r.highlights ?? []), r.text]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2500),
          query,
        });
      }
    } catch (err) {
      console.warn(`[hunts] search failed for "${query}":`, err);
    }
  }
  return hits;
}

type ConfirmItem = {
  index: number;
  confirmed: boolean;
  company_name?: string;
  domain?: string | null;
  quote?: string;
  confidence?: number;
};

/** One batched LLM call: confirm the signal per page + extract the company. */
async function confirmHits(
  hunt: IcpHunt,
  hits: PageHit[],
  icpContext: string | null,
): Promise<HuntCandidate[]> {
  if (hits.length === 0) return [];

  const pages = hits
    .map(
      (h, i) =>
        `[${i}] URL: ${h.url}\nTITLE: ${h.title ?? "—"}\nCONTENT:\n${h.text}`,
    )
    .join("\n\n---\n\n");

  const { text } = await generateText({
    model: getModel(),
    system: `You are a B2B research analyst confirming buying signals.
For each page decide: does it confirm the signal for a SPECIFIC company? Question: "${hunt.confirm}"
${
  icpContext
    ? `Target profile (ICP): ${icpContext}
- confirmed=true ALSO requires the company to plausibly fit this profile. Big-tech giants, household consumer apps, and companies obviously outside the profile are confirmed=false even when the signal itself is present.`
    : ""
}
Rules:
- confirmed=true ONLY when the page clearly supports a YES, with a short verbatim quote as proof
- company_name = the company the signal applies to (never the job board, news outlet, or aggregator)
- domain = the company's own website domain if visible on the page, else null
- Skip pages about job seekers, listicles, or where no single company is identifiable (confirmed=false)
- confidence 0-1
Respond ONLY with a JSON array: [{"index":0,"confirmed":true,"company_name":"...","domain":"..."|null,"quote":"...","confidence":0.9}]`,
    prompt: pages,
  });

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: ConfirmItem[];
  try {
    parsed = JSON.parse(match[0]) as ConfirmItem[];
  } catch {
    return [];
  }

  const out: HuntCandidate[] = [];
  for (const item of parsed) {
    if (!item.confirmed) continue;
    const hit = hits[item.index];
    if (!hit) continue;
    const name = item.company_name?.trim();
    if (!name || name.length < 2) continue;
    if (!item.quote || item.quote.trim().length < 10) continue;
    out.push({
      companyName: name,
      domain: item.domain?.trim() || null,
      source: hunt.source,
      criterionId: hunt.criterionId,
      query: hit.query,
      url: hit.url,
      title: hit.title,
      quote: item.quote.trim().slice(0, 500),
      confidence:
        typeof item.confidence === "number"
          ? Math.min(Math.max(item.confidence, 0), 1)
          : 0.7,
    });
  }
  return out;
}

export async function runHunts(
  hunts: IcpHunt[],
  opts: {
    maxCandidates?: number;
    resultsPerQuery?: number;
    excludeNamePatterns?: string[];
    /** ICP summary — the confirmer rejects companies outside the profile. */
    icpContext?: string | null;
  } = {},
): Promise<HuntCandidate[]> {
  const maxCandidates = opts.maxCandidates ?? 10;
  const resultsPerQuery = opts.resultsPerQuery ?? 5;
  const exclude = (opts.excludeNamePatterns ?? [])
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 1);

  const perHunt = await Promise.all(
    hunts.map(async (hunt) => {
      const hits = await searchHunt(hunt, resultsPerQuery);
      return confirmHits(hunt, hits.slice(0, 12), opts.icpContext ?? null);
    }),
  );

  // Dedupe by company (first hunt wins; keep highest confidence), drop
  // excluded names, interleave hunts so one source can't hog the cap.
  const byCompany = new Map<string, HuntCandidate>();
  for (
    let i = 0;
    byCompany.size < maxCandidates * 2 && perHunt.some((list) => i < list.length);
    i++
  ) {
    for (const list of perHunt) {
      const c = list[i];
      if (!c) continue;
      const key = c.companyName.toLowerCase();
      if (exclude.some((p) => key.includes(p))) continue;
      const prev = byCompany.get(key);
      if (!prev || c.confidence > prev.confidence) byCompany.set(key, c);
    }
  }

  return [...byCompany.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxCandidates);
}
