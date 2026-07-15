// ICP company discovery: search public job boards / ATS for QA/E2E postings
// and work backwards to the company. Every hit is already hiring for testing
// pain. Sources vary by market (Brazil vs global).

import type { SupabaseClient } from "@supabase/supabase-js";

import { searchUrls } from "@/lib/exa";
import {
  fetchBoardJobs,
  searchGupyJobs,
  searchLinkedInJobs,
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

// Signal-first queries: instead of "who is hiring QA", these look for the
// trigger moment itself (first QA hire, flaky suite, manual→automation
// migration) inside job-posting text. Run through the Exa ATS harvest, which
// searches full posting content, so multi-word signal phrases match.
export const SIGNAL_DISCOVERY_QUERIES = [
  '"first QA hire" OR "founding QA" OR "founding SDET" job',
  '"flaky tests" OR "test debt" hiring software engineer',
  '"manual testing" migrating to automated tests QA job',
  '"build our QA" OR "establish quality engineering" job',
];

export const BRAZIL_SIGNAL_QUERIES = [
  '"primeiro QA" OR "estruturar QA" vaga',
  '"automação de testes" migração testes manuais vaga',
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
  /** The search query that surfaced this company (signal provenance). */
  sourceQuery?: string | null;
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
  if (host.endsWith(".gupy.io")) {
    // Job pages live at {company}.gupy.io/... — subdomain is the board slug.
    const sub = host.slice(0, -".gupy.io".length);
    if (!sub || sub === "portal" || sub === "employability-portal" || sub.includes(".")) {
      return null;
    }
    return { ats: "gupy", slug: sub };
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
  if (ats === "gupy") {
    // Subdomain slugs ("vemprasofist") rarely match the API's careerPageName;
    // the career page <title> carries the real company name.
    try {
      const res = await fetch(`https://${slug}.gupy.io/`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const html = await res.text();
        const title =
          html.match(/<meta[^>]+og:site_name[^>]+content="([^"]+)"/i)?.[1] ??
          html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
        if (title) {
          const name = title
            .split(/\s*[-|–]\s*/)[0]
            .replace(/\s*(vagas|carreiras|jobs|careers)\s*/gi, "")
            .trim();
          if (name.length >= 2) return name;
        }
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
  sourceQuery?: string | null;
  /** Found via a market-scoped source (e.g. Gupy, Workable location=Brazil). */
  local?: boolean;
};

function mergeCompany(
  map: Map<string, CompanyAcc>,
  hit: CompanyAcc,
) {
  const key = `${hit.ats}:${hit.slug}`.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    existing.jobCount += hit.jobCount;
    if (!existing.sourceQuery && hit.sourceQuery) {
      existing.sourceQuery = hit.sourceQuery;
    }
    if (hit.local) existing.local = true;
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
          local: true,
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
          local: Boolean(opts.location),
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
          local: true,
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

/** LinkedIn via DDG/Exa + light og: scrape — no LinkedIn login. */
async function discoverFromLinkedIn(opts: {
  queries: string[];
  location?: string | null;
  maxCompanies: number;
}): Promise<CompanyAcc[]> {
  const map = new Map<string, CompanyAcc>();
  for (const query of opts.queries.slice(0, 3)) {
    try {
      const jobs = await searchLinkedInJobs({
        query,
        location: opts.location,
        limit: 15,
        enrich: true,
      });
      for (const job of jobs) {
        if (!job.companyName || job.companyName === "Unknown") continue;
        mergeCompany(map, {
          ats: "linkedin",
          slug: job.boardSlug,
          companyName: job.companyName,
          jobCount: 1,
          sourceUrl: job.url,
          sourceTitle: job.title,
          local: Boolean(opts.location),
        });
      }
    } catch (err) {
      console.error(`[icp-discovery] LinkedIn failed for "${query}":`, err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return [...map.values()].slice(0, opts.maxCompanies * 2);
}

async function discoverFromAtsUrlHarvest(opts: {
  queries: string[];
  numResultsPerQuery: number;
  maxCompanies: number;
  /** Extra searchable job-page domains (e.g. gupy.io for Brazil). */
  extraDomains?: string[];
}): Promise<DiscoveredCompany[]> {
  const seen = new Set<string>();
  const boards: Array<{
    ats: AtsProvider;
    slug: string;
    sourceUrl: string;
    sourceTitle: string | null;
    sourceQuery: string | null;
  }> = [];

  const collect = (
    results: Array<{ url: string; title: string | null }>,
    sourceQuery: string | null,
  ) => {
    for (const r of results) {
      const parsed = parseBoardUrl(r.url);
      if (!parsed) continue;
      const key = `${parsed.ats}:${parsed.slug}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      boards.push({
        ...parsed,
        sourceUrl: r.url,
        sourceTitle: r.title,
        sourceQuery,
      });
    }
  };

  collect(await discoverFromHackerNews({}), null);

  for (const query of opts.queries) {
    try {
      collect(
        await searchUrls({
          query,
          domains: [...ATS_JOB_DOMAINS, ...(opts.extraDomains ?? [])],
          numResults: opts.numResultsPerQuery,
        }),
        query,
      );
    } catch (err) {
      console.error(`[icp-discovery] Exa search failed for "${query}":`, err);
    }
  }

  // Round-robin across ATS types before validating: collection order puts
  // HN/Greenhouse first, and a straight scan exhausts maxCompanies before
  // ever reaching e.g. gupy.io boards from extraDomains.
  const byAts = new Map<string, typeof boards>();
  for (const b of boards) {
    const list = byAts.get(b.ats) ?? [];
    list.push(b);
    byAts.set(b.ats, list);
  }
  const ordered: typeof boards = [];
  const groups = [...byAts.values()];
  for (let i = 0; ordered.length < boards.length; i++) {
    for (const g of groups) {
      if (i < g.length) ordered.push(g[i]);
    }
  }
  // Signal-matched boards validate first so they fit inside maxCompanies.
  ordered.sort(
    (a, b) => (b.sourceQuery ? 1 : 0) - (a.sourceQuery ? 1 : 0),
  );

  const discovered: DiscoveredCompany[] = [];
  for (const board of ordered) {
    if (discovered.length >= opts.maxCompanies) break;
    // Workable company id slugs from /company/{id}/ may not work with widget —
    // skip validation failure silently.
    try {
      const jobs = await fetchBoardJobs(board.ats, board.slug);
      if (!jobs || jobs.length === 0) {
        // Still include if we only have URL evidence (search portals).
        // gupy: careerPageName API rarely matches subdomain slugs, but the
        // job URL itself is proof the board exists.
        if (
          board.ats === "workable" ||
          board.ats === "smartrecruiters" ||
          board.ats === "gupy"
        ) {
          const companyName = await resolveCompanyName(board.ats, board.slug);
          discovered.push({
            ats: board.ats,
            slug: board.slug,
            companyName,
            jobCount: 1,
            sourceUrl: board.sourceUrl,
            sourceTitle: board.sourceTitle,
            sourceQuery: board.sourceQuery,
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
        sourceQuery: board.sourceQuery,
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
  /**
   * Short terms for keyword-based boards (Gupy, Workable, LinkedIn…).
   * When omitted, `queries` (or market defaults) are used everywhere —
   * long signal phrases match nothing on keyword search, so pass this
   * whenever `queries` are full-text signal phrases.
   */
  keywords?: string[];
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
  const keywords = opts.keywords?.length
    ? opts.keywords
    : market === "brazil"
      ? BRAZIL_DISCOVERY_QUERIES
      : queries;

  const map = new Map<string, CompanyAcc>();

  if (market === "brazil") {
    // Multi-source Brazil: Gupy + Workable + Programathor + LinkedIn +
    // Remotive + ATS URL harvest.
    const [gupy, workable, programathor, remotive, linkedin, harvest] =
      await Promise.all([
        discoverFromGupy({ queries: keywords, maxCompanies }),
        discoverFromWorkable({
          queries: keywords,
          location: "Brazil",
          maxCompanies,
        }),
        discoverFromProgramathor({ queries: keywords, maxCompanies }),
        discoverFromRemotive({
          queries: keywords.slice(0, 3),
          maxCompanies,
        }),
        discoverFromLinkedIn({
          queries: keywords.slice(0, 3),
          location: "Brazil",
          maxCompanies,
        }),
        discoverFromAtsUrlHarvest({
          queries: [
            ...queries.slice(0, 3),
            ...BRAZIL_SIGNAL_QUERIES,
            ...SIGNAL_DISCOVERY_QUERIES.slice(0, 2),
          ],
          numResultsPerQuery: opts.numResultsPerQuery ?? 15,
          maxCompanies,
          // Gupy job pages are public ({company}.gupy.io) — lets signal
          // phrases hit Brazilian posting text, not just global ATS boards.
          extraDomains: ["gupy.io"],
        }),
      ]);

    for (const c of [
      ...gupy,
      ...workable,
      ...programathor,
      ...remotive,
      ...linkedin,
    ]) {
      mergeCompany(map, c);
    }
    for (const c of harvest) {
      mergeCompany(map, { ...c, local: c.ats === "gupy" });
    }

    // Brazil-first ranking: global harvest boards carry big job counts and
    // would crowd out market-scoped hits (jobCount 1-3) in a pure jobCount
    // sort. Signal-matched companies (sourceQuery set — found via a trigger
    // phrase, not a generic keyword) outrank raw job counts. Fill at least
    // half the slots with local-source companies.
    const rank = (c: CompanyAcc) =>
      (c.sourceQuery ? 1_000_000 : 0) + c.jobCount;
    const all = [...map.values()].sort((a, b) => rank(b) - rank(a));
    const brazilian = all.filter((c) => c.local);
    const other = all.filter((c) => !c.local);
    const quota = Math.ceil(maxCompanies / 2);
    const picked = [
      ...brazilian.slice(0, Math.max(quota, maxCompanies - other.length)),
      ...other,
    ].slice(0, maxCompanies);
    return picked.map((c) => ({
      ats: c.ats,
      slug: c.slug,
      companyName: c.companyName,
      jobCount: c.jobCount,
      sourceUrl: c.sourceUrl,
      sourceTitle: c.sourceTitle,
      sourceQuery: c.sourceQuery ?? null,
    }));
  } else {
    // Global: classic ATS harvest + Workable + Remotive + LinkedIn.
    const [harvest, workable, remotive, linkedin] = await Promise.all([
      discoverFromAtsUrlHarvest({
        queries: [...queries, ...SIGNAL_DISCOVERY_QUERIES],
        numResultsPerQuery: opts.numResultsPerQuery ?? 25,
        maxCompanies: maxCompanies * 2,
      }),
      discoverFromWorkable({
        queries: keywords,
        location: null,
        maxCompanies,
      }),
      discoverFromRemotive({ queries: keywords, maxCompanies }),
      discoverFromLinkedIn({
        queries: keywords.slice(0, 2),
        location: null,
        maxCompanies,
      }),
    ]);

    for (const c of harvest) mergeCompany(map, c);
    for (const c of workable) mergeCompany(map, c);
    for (const c of remotive) mergeCompany(map, c);
    for (const c of linkedin) mergeCompany(map, c);
  }

  return [...map.values()]
    .sort(
      (a, b) =>
        (b.sourceQuery ? 1_000_000 : 0) +
        b.jobCount -
        ((a.sourceQuery ? 1_000_000 : 0) + a.jobCount),
    )
    .slice(0, maxCompanies)
    .map((c) => ({
      ats: c.ats,
      slug: c.slug,
      companyName: c.companyName,
      jobCount: c.jobCount,
      sourceUrl: c.sourceUrl,
      sourceTitle: c.sourceTitle,
      sourceQuery: c.sourceQuery ?? null,
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
