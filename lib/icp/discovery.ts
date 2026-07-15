// ICP company discovery: search public job boards / ATS for QA/E2E postings
// and work backwards to the company. Every hit is already hiring for testing
// pain. Sources vary by market (Brazil vs global).

import type { SupabaseClient } from "@supabase/supabase-js";

import { searchUrls } from "@/lib/exa";
import {
  fetchBoardJobs,
  searchGupyJobs,
  searchProgramathorJobs,
  searchRemotiveJobs,
  searchWorkableJobs,
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

export const BRAZIL_DISCOVERY_QUERIES = [
  "QA",
  "SDET",
  "Playwright",
  "Cypress",
  "Automação de testes",
  "Quality Assurance",
  "Analista de Testes",
];

const ATS_JOB_DOMAINS = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "apply.workable.com",
  "jobs.workable.com",
  "jobs.smartrecruiters.com",
  "careers.smartrecruiters.com",
];

const HN_ATS_URL_RE =
  /https?:\/\/(?:www\.)?(?:boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|jobs\.smartrecruiters\.com|careers\.smartrecruiters\.com)\/[^\s"'<>)\]]+/g;

export type DiscoveredCompany = {
  ats: AtsProvider;
  slug: string;
  companyName: string;
  jobCount: number;
  sourceUrl: string;
  sourceTitle: string | null;
};

// greenhouse: boards.greenhouse.io/{slug}/jobs/{id}
// lever:      jobs.lever.co/{slug}/{posting-id}
// ashby:      jobs.ashbyhq.com/{slug}/{posting-id}
// workable:   apply.workable.com/{slug}/  | jobs.workable.com/view/...
// smartrecruiters: jobs.smartrecruiters.com/{Company}/{id}
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
  const slug = segments[0];
  if (!slug) return null;

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    if (slug.toLowerCase() === "embed") return null;
    return { ats: "greenhouse", slug: slug.toLowerCase() };
  }
  if (host === "jobs.lever.co") return { ats: "lever", slug: slug.toLowerCase() };
  if (host === "jobs.ashbyhq.com")
    return { ats: "ashby", slug: slug.toLowerCase() };
  if (host === "apply.workable.com") {
    // /j/{shortcode} is a job, not an account board
    if (slug.toLowerCase() === "j") return null;
    return { ats: "workable", slug: slug.toLowerCase() };
  }
  if (host === "jobs.workable.com") {
    // /company/{id}/jobs-at-{name} or /view/...
    if (slug.toLowerCase() === "company" && segments[1]) {
      return { ats: "workable", slug: segments[1] };
    }
    return null;
  }
  if (
    host === "jobs.smartrecruiters.com" ||
    host === "careers.smartrecruiters.com"
  ) {
    // Identifier is often PascalCase — keep original casing
    return { ats: "smartrecruiters", slug };
  }
  if (host === "programathor.com.br" || host === "www.programathor.com.br") {
    return null; // company resolved via listing scrape, not URL slug
  }
  if (host === "remotive.com" || host === "remotive.io") {
    return null;
  }
  return null;
}

async function resolveCompanyName(
  ats: AtsProvider,
  slug: string,
): Promise<string> {
  if (ats === "greenhouse") {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { name?: string };
        if (data.name) return data.name;
      }
    } catch {
      // fall through
    }
  }
  if (ats === "workable") {
    try {
      const res = await fetch(
        `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { name?: string };
        if (data.name) return data.name;
      }
    } catch {
      // fall through
    }
  }
  if (ats === "smartrecruiters") {
    try {
      const res = await fetch(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          content?: Array<{ company?: { name?: string } }>;
        };
        const name = data.content?.[0]?.company?.name;
        if (name) return name;
      }
    } catch {
      // fall through
    }
  }
  return slug
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function discoverFromHackerNews(opts: {
  daysBack?: number;
}): Promise<Array<{ url: string; title: string | null }>> {
  const daysBack = opts.daysBack ?? 45;
  const since = Math.floor(Date.now() / 1000) - daysBack * 86_400;
  const found: Array<{ url: string; title: string | null }> = [];

  const domains = [
    "boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
    "apply.workable.com",
    "jobs.smartrecruiters.com",
  ];

  for (const domain of domains) {
    try {
      const res = await fetch(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(
          `"${domain}"`,
        )}&tags=comment&hitsPerPage=200&numericFilters=created_at_i>${since}`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        hits?: Array<{ comment_text?: string; story_title?: string }>;
      };
      for (const hit of data.hits ?? []) {
        if (!hit.comment_text) continue;
        const text = hit.comment_text
          .replace(/&#x2F;/g, "/")
          .replace(/&amp;/g, "&");
        const urls = text.match(HN_ATS_URL_RE);
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

type CompanyAcc = {
  ats: AtsProvider;
  slug: string;
  companyName: string;
  jobCount: number;
  sourceUrl: string;
  sourceTitle: string | null;
};

function mergeCompany(
  map: Map<string, CompanyAcc>,
  hit: CompanyAcc,
) {
  const key = `${hit.ats}:${hit.slug}`.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    existing.jobCount += hit.jobCount;
    return;
  }
  // Also merge same company name across sources (prefer first ATS).
  for (const [k, v] of map) {
    if (
      v.companyName.toLowerCase() === hit.companyName.toLowerCase() &&
      hit.companyName.length > 2
    ) {
      v.jobCount += hit.jobCount;
      return;
    }
    void k;
  }
  map.set(key, { ...hit });
}

async function discoverFromGupy(opts: {
  queries: string[];
  maxCompanies: number;
}): Promise<CompanyAcc[]> {
  const map = new Map<string, CompanyAcc>();
  for (const query of opts.queries) {
    try {
      const jobs = await searchGupyJobs(query, 50);
      for (const job of jobs) {
        mergeCompany(map, {
          ats: "gupy",
          slug: job.companyName,
          companyName: job.companyName,
          jobCount: 1,
          sourceUrl: job.url,
          sourceTitle: job.title,
        });
      }
    } catch (err) {
      console.error(`[icp-discovery] Gupy failed for "${query}":`, err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return [...map.values()].slice(0, opts.maxCompanies * 2);
}

async function discoverFromWorkable(opts: {
  queries: string[];
  location?: string | null;
  maxCompanies: number;
}): Promise<CompanyAcc[]> {
  const map = new Map<string, CompanyAcc>();
  for (const query of opts.queries.slice(0, 4)) {
    try {
      const jobs = await searchWorkableJobs({
        query,
        location: opts.location,
        limit: 40,
      });
      for (const job of jobs) {
        mergeCompany(map, {
          ats: "workable",
          slug: job.boardSlug,
          companyName: job.companyName,
          jobCount: 1,
          sourceUrl: job.url,
          sourceTitle: job.title,
        });
      }
    } catch (err) {
      console.error(`[icp-discovery] Workable failed for "${query}":`, err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return [...map.values()].slice(0, opts.maxCompanies * 2);
}

async function discoverFromProgramathor(opts: {
  queries: string[];
  maxCompanies: number;
}): Promise<CompanyAcc[]> {
  const map = new Map<string, CompanyAcc>();
  for (const query of opts.queries.slice(0, 5)) {
    try {
      const jobs = await searchProgramathorJobs(query, 25);
      for (const job of jobs) {
        mergeCompany(map, {
          ats: "programathor",
          slug: job.boardSlug,
          companyName: job.companyName,
          jobCount: 1,
          sourceUrl: job.url,
          sourceTitle: job.title,
        });
      }
    } catch (err) {
      console.error(
        `[icp-discovery] Programathor failed for "${query}":`,
        err,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return [...map.values()].slice(0, opts.maxCompanies * 2);
}

async function discoverFromRemotive(opts: {
  queries: string[];
  maxCompanies: number;
}): Promise<CompanyAcc[]> {
  const map = new Map<string, CompanyAcc>();
  for (const query of opts.queries.slice(0, 3)) {
    try {
      const jobs = await searchRemotiveJobs(query, 40);
      for (const job of jobs) {
        mergeCompany(map, {
          ats: "remotive",
          slug: job.boardSlug,
          companyName: job.companyName,
          jobCount: 1,
          sourceUrl: job.url,
          sourceTitle: job.title,
        });
      }
    } catch (err) {
      console.error(`[icp-discovery] Remotive failed for "${query}":`, err);
    }
  }
  return [...map.values()].slice(0, opts.maxCompanies * 2);
}

async function discoverFromAtsUrlHarvest(opts: {
  queries: string[];
  numResultsPerQuery: number;
  maxCompanies: number;
}): Promise<DiscoveredCompany[]> {
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
      const key = `${parsed.ats}:${parsed.slug}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      boards.push({ ...parsed, sourceUrl: r.url, sourceTitle: r.title });
    }
  };

  collect(await discoverFromHackerNews({}));

  for (const query of opts.queries) {
    try {
      collect(
        await searchUrls({
          query,
          domains: ATS_JOB_DOMAINS,
          numResults: opts.numResultsPerQuery,
        }),
      );
    } catch (err) {
      console.error(`[icp-discovery] Exa search failed for "${query}":`, err);
    }
  }

  const discovered: DiscoveredCompany[] = [];
  for (const board of boards) {
    if (discovered.length >= opts.maxCompanies) break;
    // Workable company id slugs from /company/{id}/ may not work with widget —
    // skip validation failure silently.
    try {
      const jobs = await fetchBoardJobs(board.ats, board.slug);
      if (!jobs || jobs.length === 0) {
        // Still include if we only have URL evidence (search portals).
        if (board.ats === "workable" || board.ats === "smartrecruiters") {
          const companyName = await resolveCompanyName(board.ats, board.slug);
          discovered.push({
            ats: board.ats,
            slug: board.slug,
            companyName,
            jobCount: 1,
            sourceUrl: board.sourceUrl,
            sourceTitle: board.sourceTitle,
          });
        }
        continue;
      }
      const companyName = await resolveCompanyName(board.ats, board.slug);
      discovered.push({
        ats: board.ats,
        slug: board.slug,
        companyName,
        jobCount: jobs.length,
        sourceUrl: board.sourceUrl,
        sourceTitle: board.sourceTitle,
      });
    } catch (err) {
      console.error(
        `[icp-discovery] validate ${board.ats}/${board.slug}:`,
        err,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return discovered;
}

export async function discoverCompanies(opts: {
  queries?: string[];
  numResultsPerQuery?: number;
  maxCompanies?: number;
  market?: DiscoveryMarket;
}): Promise<DiscoveredCompany[]> {
  const maxCompanies = opts.maxCompanies ?? 20;
  const market = opts.market ?? "global";
  const queries =
    opts.queries?.length
      ? opts.queries
      : market === "brazil"
        ? BRAZIL_DISCOVERY_QUERIES
        : DEFAULT_DISCOVERY_QUERIES;

  const map = new Map<string, CompanyAcc>();

  if (market === "brazil") {
    // Multi-source Brazil: Gupy + Workable (location Brazil) + Programathor
    // + Remotive (remote, often hire BR) + ATS URL harvest.
    const [gupy, workable, programathor, remotive, harvest] =
      await Promise.all([
        discoverFromGupy({ queries, maxCompanies }),
        discoverFromWorkable({
          queries,
          location: "Brazil",
          maxCompanies,
        }),
        discoverFromProgramathor({ queries, maxCompanies }),
        discoverFromRemotive({
          queries: ["QA", "SDET", "Playwright"],
          maxCompanies,
        }),
        discoverFromAtsUrlHarvest({
          queries: queries.slice(0, 3),
          numResultsPerQuery: opts.numResultsPerQuery ?? 15,
          maxCompanies,
        }),
      ]);

    for (const c of [...gupy, ...workable, ...programathor, ...remotive]) {
      mergeCompany(map, c);
    }
    for (const c of harvest) {
      mergeCompany(map, c);
    }
  } else {
    // Global: classic ATS harvest + Workable search + Remotive.
    const [harvest, workable, remotive] = await Promise.all([
      discoverFromAtsUrlHarvest({
        queries,
        numResultsPerQuery: opts.numResultsPerQuery ?? 25,
        maxCompanies: maxCompanies * 2,
      }),
      discoverFromWorkable({
        queries,
        location: null,
        maxCompanies,
      }),
      discoverFromRemotive({ queries, maxCompanies }),
    ]);

    for (const c of harvest) mergeCompany(map, c);
    for (const c of workable) mergeCompany(map, c);
    for (const c of remotive) mergeCompany(map, c);
  }

  return [...map.values()]
    .sort((a, b) => b.jobCount - a.jobCount)
    .slice(0, maxCompanies)
    .map((c) => ({
      ats: c.ats,
      slug: c.slug,
      companyName: c.companyName,
      jobCount: c.jobCount,
      sourceUrl: c.sourceUrl,
      sourceTitle: c.sourceTitle,
    }));
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
      console.error(
        `[icp-discovery] watchlist add failed for ${company.slug}:`,
        err,
      );
    }
  }
  return { discovered, added };
}
