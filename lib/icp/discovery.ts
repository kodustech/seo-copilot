// ICP company discovery: instead of asking "does company X have a QA
// opening?", search the public ATS job boards for QA/E2E postings and work
// backwards to the company. Every hit is a company that is ALREADY hiring for
// testing pain, so it enters the watchlist born with a signal. Search goes
// through Exa (lean URL-only calls); board slugs are parsed from posting URLs
// and validated against the free ATS APIs.

import type { SupabaseClient } from "@supabase/supabase-js";

import { searchUrls } from "@/lib/exa";
import {
  fetchBoardJobs,
  searchGupyJobs,
  type AtsProvider,
} from "@/lib/icp/job-boards";
import { addToWatchlist, type WatchlistEntry } from "@/lib/icp/scanner";

export type DiscoveryMarket = "global" | "brazil";

// Queries mirror the ICP's strong signals: QA automation hiring, suite
// rescue, E2E tooling. Kept short — Exa autoprompt does the expansion.
export const DEFAULT_DISCOVERY_QUERIES = [
  "QA Automation Engineer end-to-end tests flaky CI",
  "SDET Playwright Cypress test suite job",
  "Software Engineer in Test E2E automation job",
];

const ATS_JOB_DOMAINS = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
];

export type DiscoveredCompany = {
  ats: AtsProvider;
  slug: string;
  companyName: string;
  jobCount: number;
  sourceUrl: string;
  sourceTitle: string | null;
};

// greenhouse: boards.greenhouse.io/{slug}/jobs/{id} | job-boards.greenhouse.io/{slug}/jobs/{id}
// lever:      jobs.lever.co/{slug}/{posting-id}
// ashby:      jobs.ashbyhq.com/{slug}/{posting-id}
export function parseBoardUrl(
  url: string,
): { ats: AtsProvider; slug: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  const slug = segments[0]?.toLowerCase();
  if (!slug) return null;

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    // Skip non-board paths like /embed.
    if (slug === "embed") return null;
    return { ats: "greenhouse", slug };
  }
  if (host === "jobs.lever.co") return { ats: "lever", slug };
  if (host === "jobs.ashbyhq.com") return { ats: "ashby", slug };
  return null;
}

// Company display name: Greenhouse exposes it on the board API; Lever/Ashby
// public APIs don't, so fall back to a humanized slug.
async function resolveCompanyName(ats: AtsProvider, slug: string): Promise<string> {
  if (ats === "greenhouse") {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { name?: string };
        if (data.name) return data.name;
      }
    } catch {
      // fall through to humanized slug
    }
  }
  return slug
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Free primary source: HN Algolia. "Who is hiring" comments (and job posts in
// general) link straight to ATS boards; harvest those links and let the
// scanner qualify the company afterwards. No key, no credits.
async function discoverFromHackerNews(opts: {
  daysBack?: number;
}): Promise<Array<{ url: string; title: string | null }>> {
  const daysBack = opts.daysBack ?? 45;
  const since = Math.floor(Date.now() / 1000) - daysBack * 86_400;
  const found: Array<{ url: string; title: string | null }> = [];

  for (const domain of ATS_JOB_DOMAINS) {
    try {
      const res = await fetch(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(
          `"${domain}"`,
        )}&tags=comment&hitsPerPage=200&numericFilters=created_at_i>${since}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        hits?: Array<{ comment_text?: string; story_title?: string }>;
      };
      for (const hit of data.hits ?? []) {
        if (!hit.comment_text) continue;
        // HN encodes URLs in comment HTML (slashes as &#x2F;).
        const text = hit.comment_text
          .replace(/&#x2F;/g, "/")
          .replace(/&amp;/g, "&");
        const urls = text.match(
          /https?:\/\/(?:www\.)?(?:boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)\/[^\s"'<>)\]]+/g,
        );
        for (const url of urls ?? []) {
          found.push({ url, title: hit.story_title ?? "HN comment" });
        }
      }
    } catch (err) {
      console.error(`[icp-discovery] HN search failed for ${domain}:`, err);
    }
  }
  return found;
}

// Brazilian market: search the Gupy portal (dominant BR ATS, free public
// API) for QA/testing-intent postings and group by company. Every posting
// already carries company name + country, so no board probing is needed.
export const BRAZIL_DISCOVERY_QUERIES = [
  "QA",
  "SDET",
  "Playwright",
  "Cypress",
  "Automação de testes",
];

async function discoverFromGupy(opts: {
  queries?: string[];
  maxCompanies: number;
}): Promise<DiscoveredCompany[]> {
  const queries = opts.queries?.length ? opts.queries : BRAZIL_DISCOVERY_QUERIES;
  const byCompany = new Map<string, { jobCount: number; sourceUrl: string; sourceTitle: string | null }>();

  for (const query of queries) {
    const jobs = await searchGupyJobs(query, 50);
    for (const job of jobs) {
      const existing = byCompany.get(job.companyName);
      if (existing) {
        existing.jobCount += 1;
      } else {
        byCompany.set(job.companyName, {
          jobCount: 1,
          sourceUrl: job.url,
          sourceTitle: job.title,
        });
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return Array.from(byCompany.entries())
    .slice(0, opts.maxCompanies)
    .map(([companyName, info]) => ({
      ats: "gupy" as const,
      slug: companyName, // gupy fetches by exact career-page name
      companyName,
      jobCount: info.jobCount,
      sourceUrl: info.sourceUrl,
      sourceTitle: info.sourceTitle,
    }));
}

export async function discoverCompanies(opts: {
  queries?: string[];
  numResultsPerQuery?: number;
  maxCompanies?: number;
  market?: DiscoveryMarket;
}): Promise<DiscoveredCompany[]> {
  const maxCompanies = opts.maxCompanies ?? 20;
  if (opts.market === "brazil") {
    return discoverFromGupy({ queries: opts.queries, maxCompanies });
  }
  const queries = opts.queries?.length ? opts.queries : DEFAULT_DISCOVERY_QUERIES;

  const seen = new Set<string>();
  const boards: Array<{
    ats: AtsProvider;
    slug: string;
    sourceUrl: string;
    sourceTitle: string | null;
  }> = [];

  const collect = (results: Array<{ url: string; title: string | null }>) => {
    for (const r of results) {
      const parsed = parseBoardUrl(r.url);
      if (!parsed) continue;
      const key = `${parsed.ats}:${parsed.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      boards.push({ ...parsed, sourceUrl: r.url, sourceTitle: r.title });
    }
  };

  // Primary: HN Algolia (free). Secondary: Exa web search (best effort — may
  // be out of credits, in which case it just logs and moves on).
  collect(await discoverFromHackerNews({}));

  for (const query of queries) {
    try {
      collect(
        await searchUrls({
          query,
          domains: ATS_JOB_DOMAINS,
          numResults: opts.numResultsPerQuery ?? 25,
        }),
      );
    } catch (err) {
      console.error(`[icp-discovery] Exa search failed for "${query}":`, err);
    }
  }

  // Validate each board against the free ATS API (dead boards drop out) and
  // resolve a display name. Sequential with a politeness gap.
  const discovered: DiscoveredCompany[] = [];
  for (const board of boards) {
    if (discovered.length >= maxCompanies) break;
    const jobs = await fetchBoardJobs(board.ats, board.slug);
    if (!jobs || jobs.length === 0) continue;
    const companyName = await resolveCompanyName(board.ats, board.slug);
    discovered.push({
      ats: board.ats,
      slug: board.slug,
      companyName,
      jobCount: jobs.length,
      sourceUrl: board.sourceUrl,
      sourceTitle: board.sourceTitle,
    });
    await new Promise((r) => setTimeout(r, 300));
  }
  return discovered;
}

export async function discoverAndWatch(
  client: SupabaseClient,
  opts: {
    queries?: string[];
    maxCompanies?: number;
    market?: DiscoveryMarket;
    addedByEmail?: string | null;
  } = {},
): Promise<{ discovered: DiscoveredCompany[]; added: WatchlistEntry[] }> {
  const discovered = await discoverCompanies(opts);
  const added: WatchlistEntry[] = [];
  for (const company of discovered) {
    try {
      const { entry } = await addToWatchlist(client, {
        companyName: company.companyName,
        ats: company.ats,
        boardSlug: company.slug,
        addedByEmail: opts.addedByEmail ?? null,
      });
      added.push(entry);
    } catch (err) {
      console.error(`[icp-discovery] watchlist add failed for ${company.slug}:`, err);
    }
  }
  return { discovered, added };
}
