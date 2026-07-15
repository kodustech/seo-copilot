// Public ATS / job-board collectors. Prefer unauthenticated JSON APIs; HTML
// scrape only where the portal has no usable API (Programathor).
// Each collector normalizes into JobPosting for the classifier / research packs.

export type AtsProvider =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "gupy"
  | "workable"
  | "smartrecruiters"
  | "programathor"
  | "remotive"
  | "linkedin";

export const ATS_PROVIDERS: AtsProvider[] = [
  "greenhouse",
  "lever",
  "ashby",
  "gupy",
  "workable",
  "smartrecruiters",
  "programathor",
  "remotive",
  "linkedin",
];

/** Providers we probe when guessing a company board slug. */
const SLUG_PROBE_ATS: AtsProvider[] = [
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "smartrecruiters",
];

export type JobPosting = {
  title: string;
  url: string;
  location: string | null;
  team: string | null;
  content: string; // plain text, truncated
  publishedAt: string | null;
};

/** Discovery hit that may not map to a traditional board slug. */
export type AggregatedJob = JobPosting & {
  companyName: string;
  ats: AtsProvider;
  boardSlug: string;
};

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 6_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchText(
  url: string,
  headers: Record<string, string> = {},
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": BROWSER_UA,
        ...headers,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Greenhouse returns job content as HTML-escaped HTML; flatten to plain text.
export function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string): string {
  return text.length > MAX_CONTENT_CHARS
    ? text.slice(0, MAX_CONTENT_CHARS)
    : text;
}

// ---------------------------------------------------------------------------
// Greenhouse
// ---------------------------------------------------------------------------

export async function fetchGreenhouseJobs(
  slug: string,
): Promise<JobPosting[] | null> {
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  );
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { jobs?: unknown }).jobs)
  ) {
    return null;
  }
  type GhJob = {
    title?: string;
    absolute_url?: string;
    content?: string;
    updated_at?: string;
    location?: { name?: string };
    departments?: Array<{ name?: string }>;
  };
  return ((data as { jobs: GhJob[] }).jobs)
    .filter((j) => j.title && j.absolute_url)
    .map((j) => ({
      title: j.title as string,
      url: j.absolute_url as string,
      location: j.location?.name ?? null,
      team: j.departments?.[0]?.name ?? null,
      content: truncate(htmlToText(j.content ?? "")),
      publishedAt: j.updated_at ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Lever
// ---------------------------------------------------------------------------

export async function fetchLeverJobs(slug: string): Promise<JobPosting[] | null> {
  const data = await fetchJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  );
  if (!Array.isArray(data)) return null;
  type LeverJob = {
    text?: string;
    hostedUrl?: string;
    descriptionPlain?: string;
    createdAt?: number;
    categories?: { location?: string; team?: string };
  };
  return (data as LeverJob[])
    .filter((j) => j.text && j.hostedUrl)
    .map((j) => ({
      title: j.text as string,
      url: j.hostedUrl as string,
      location: j.categories?.location ?? null,
      team: j.categories?.team ?? null,
      content: truncate(j.descriptionPlain ?? ""),
      publishedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    }));
}

// ---------------------------------------------------------------------------
// Ashby
// ---------------------------------------------------------------------------

export async function fetchAshbyJobs(slug: string): Promise<JobPosting[] | null> {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
  );
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { jobs?: unknown }).jobs)
  ) {
    return null;
  }
  type AshbyJob = {
    title?: string;
    jobUrl?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    publishedAt?: string;
    location?: string;
    department?: string;
    isListed?: boolean;
  };
  return ((data as { jobs: AshbyJob[] }).jobs)
    .filter((j) => j.title && j.jobUrl && j.isListed !== false)
    .map((j) => ({
      title: j.title as string,
      url: j.jobUrl as string,
      location: j.location ?? null,
      team: j.department ?? null,
      content: truncate(
        j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
      ),
      publishedAt: j.publishedAt ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Gupy (dominant Brazilian ATS)
// ---------------------------------------------------------------------------

export type GupyJob = JobPosting & {
  companyName: string;
  country: string | null;
  city: string | null;
  isRemote: boolean;
};

const GUPY_API = "https://employability-portal.gupy.io/api/v1/jobs";
const GUPY_HEADERS = {
  Accept: "application/json",
  "User-Agent": BROWSER_UA,
};

type GupyRawJob = {
  name?: string;
  description?: string;
  careerPageName?: string;
  jobUrl?: string;
  publishedDate?: string;
  city?: string;
  state?: string;
  country?: string;
  isRemoteWork?: boolean;
};

function gupyRawToJob(j: GupyRawJob): GupyJob {
  return {
    title: j.name?.trim() ?? "",
    url: (j.jobUrl ?? "").split("?")[0],
    location:
      [j.city, j.state, j.country].filter(Boolean).join(", ") ||
      (j.isRemoteWork ? "Remote" : null),
    team: null,
    content: (j.description ?? "").replace(/<[^>]+>/g, " ").slice(0, 6_000),
    publishedAt: j.publishedDate ?? null,
    companyName: j.careerPageName ?? "",
    country: j.country ?? null,
    city: j.city ?? null,
    isRemote: j.isRemoteWork ?? false,
  };
}

export async function fetchGupyCompanyJobs(
  careerPageName: string,
): Promise<JobPosting[] | null> {
  try {
    const res = await fetch(
      `${GUPY_API}?careerPageName=${encodeURIComponent(careerPageName)}&limit=100`,
      { headers: GUPY_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: GupyRawJob[] };
    if (!Array.isArray(data.data)) return null;
    return data.data.map(gupyRawToJob).filter((j) => j.title && j.url);
  } catch {
    return null;
  }
}

export async function searchGupyJobs(
  query: string,
  limit = 50,
): Promise<GupyJob[]> {
  try {
    const res = await fetch(
      `${GUPY_API}?jobName=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: GUPY_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: GupyRawJob[] };
    return (data.data ?? [])
      .map(gupyRawToJob)
      .filter((j) => j.title && j.url && j.companyName);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Workable — widget board + public jobs search
// ---------------------------------------------------------------------------

type WorkableWidgetJob = {
  title?: string;
  shortcode?: string;
  department?: string;
  url?: string;
  published_on?: string;
  country?: string;
  city?: string;
  state?: string;
};

async function fetchWorkableJobDetail(
  account: string,
  shortcode: string,
): Promise<string> {
  const data = await fetchJson(
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${encodeURIComponent(shortcode)}`,
    { "User-Agent": BROWSER_UA },
  );
  if (!data || typeof data !== "object") return "";
  const d = data as {
    description?: string;
    requirements?: string;
    benefits?: string;
  };
  return truncate(
    htmlToText(
      [d.description, d.requirements, d.benefits].filter(Boolean).join("\n\n"),
    ),
  );
}

export async function fetchWorkableJobs(
  slug: string,
): Promise<JobPosting[] | null> {
  const data = await fetchJson(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`,
    { "User-Agent": BROWSER_UA },
  );
  if (!data || typeof data !== "object") return null;
  const jobs = (data as { jobs?: WorkableWidgetJob[] }).jobs;
  if (!Array.isArray(jobs)) return null;
  // Empty board is valid (company exists but no open roles) — treat as miss
  // so detectBoard keeps probing other ATS.
  if (jobs.length === 0) return null;

  // Enrich a subset with full descriptions (LLM classifier needs body text).
  const enrichLimit = 25;
  const out: JobPosting[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (!j.title || !j.shortcode) continue;
    let content = "";
    if (i < enrichLimit) {
      content = await fetchWorkableJobDetail(slug, j.shortcode);
      // Polite gap
      if (i < enrichLimit - 1) {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    out.push({
      title: j.title,
      url: j.url ?? `https://apply.workable.com/j/${j.shortcode}`,
      location:
        [j.city, j.state, j.country].filter(Boolean).join(", ") || null,
      team: j.department ?? null,
      content,
      publishedAt: j.published_on ?? null,
    });
  }
  return out.length > 0 ? out : null;
}

/** Cross-company Workable search (great for Brazil + global discovery). */
export async function searchWorkableJobs(opts: {
  query: string;
  location?: string | null;
  limit?: number;
}): Promise<AggregatedJob[]> {
  const limit = opts.limit ?? 40;
  const params = new URLSearchParams();
  params.set("query", opts.query);
  if (opts.location) params.set("location", opts.location);
  // API returns ~page of results; no hard limit param, but location+query scopes it.

  const data = await fetchJson(
    `https://jobs.workable.com/api/v1/jobs?${params.toString()}`,
    { "User-Agent": BROWSER_UA },
  );
  if (!data || typeof data !== "object") return [];
  type WbJob = {
    title?: string;
    description?: string;
    requirementsSection?: string;
    url?: string;
    created?: string;
    department?: string;
    locations?: string[];
    location?: { city?: string; countryName?: string };
    company?: {
      title?: string;
      website?: string;
      url?: string;
      id?: string;
    };
  };
  const jobs = ((data as { jobs?: WbJob[] }).jobs ?? []).slice(0, limit);
  const out: AggregatedJob[] = [];
  for (const j of jobs) {
    if (!j.title || !j.url || !j.company?.title) continue;
    // Prefer website host as board slug for later detect; fall back to company title.
    let slug = j.company.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 40);
    if (j.company.website) {
      try {
        const host = new URL(
          j.company.website.startsWith("http")
            ? j.company.website
            : `https://${j.company.website}`,
        ).hostname.replace(/^www\./, "");
        const base = host.split(".")[0];
        if (base) slug = base;
      } catch {
        // keep title slug
      }
    }
    out.push({
      title: j.title,
      url: j.url,
      location:
        j.locations?.join(", ") ||
        [j.location?.city, j.location?.countryName].filter(Boolean).join(", ") ||
        null,
      team: j.department ?? null,
      content: truncate(
        htmlToText(
          [j.description, j.requirementsSection].filter(Boolean).join("\n\n"),
        ),
      ),
      publishedAt: j.created ?? null,
      companyName: j.company.title,
      ats: "workable",
      boardSlug: slug,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SmartRecruiters
// ---------------------------------------------------------------------------

export async function fetchSmartRecruitersJobs(
  companyIdentifier: string,
): Promise<JobPosting[] | null> {
  const data = await fetchJson(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyIdentifier)}/postings?limit=100`,
  );
  if (!data || typeof data !== "object") return null;
  type SrJob = {
    id?: string;
    name?: string;
    uuid?: string;
    releasedDate?: string;
    postingUrl?: string;
    location?: { fullLocation?: string; city?: string; country?: string };
    department?: { label?: string };
  };
  const content = (data as { content?: SrJob[] }).content;
  if (!Array.isArray(content)) return null;
  if (content.length === 0) return null;

  const out: JobPosting[] = [];
  // Fetch job ads for first N for body text.
  const enrichLimit = 20;
  for (let i = 0; i < content.length; i++) {
    const j = content[i];
    if (!j.name || !j.id) continue;
    let body = "";
    if (i < enrichLimit) {
      const detail = await fetchJson(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyIdentifier)}/postings/${encodeURIComponent(j.id)}`,
      );
      if (detail && typeof detail === "object") {
        const ad = (detail as { jobAd?: { sections?: Record<string, { text?: string }> } })
          .jobAd;
        const sections = ad?.sections ?? {};
        body = truncate(
          htmlToText(
            Object.values(sections)
              .map((s) => s?.text ?? "")
              .join("\n\n"),
          ),
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    out.push({
      title: j.name,
      url:
        j.postingUrl ??
        `https://jobs.smartrecruiters.com/${companyIdentifier}/${j.id}`,
      location:
        j.location?.fullLocation ??
        ([j.location?.city, j.location?.country].filter(Boolean).join(", ") ||
          null),
      team: j.department?.label ?? null,
      content: body,
      publishedAt: j.releasedDate ?? null,
    });
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Remotive (remote aggregator — discovery + virtual board per company)
// ---------------------------------------------------------------------------

export async function searchRemotiveJobs(
  query: string,
  limit = 40,
): Promise<AggregatedJob[]> {
  const data = await fetchJson(
    `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}`,
  );
  if (!data || typeof data !== "object") return [];
  type RemJob = {
    id?: number;
    url?: string;
    title?: string;
    company_name?: string;
    category?: string;
    publication_date?: string;
    candidate_required_location?: string;
    description?: string;
  };
  const jobs = ((data as { jobs?: RemJob[] }).jobs ?? []).slice(0, limit);
  return jobs
    .filter((j) => j.title && j.url && j.company_name)
    .map((j) => {
      const slug = j.company_name!
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 40);
      return {
        title: j.title as string,
        url: j.url as string,
        location: j.candidate_required_location ?? "Remote",
        team: j.category ?? null,
        content: truncate(htmlToText(j.description ?? "")),
        publishedAt: j.publication_date ?? null,
        companyName: j.company_name as string,
        ats: "remotive" as const,
        boardSlug: slug || `remotive-${j.id ?? "x"}`,
      };
    });
}

export async function fetchRemotiveCompanyJobs(
  companySlug: string,
): Promise<JobPosting[] | null> {
  // Remotive has no per-company API — search by slug-ish name and filter.
  const hits = await searchRemotiveJobs(companySlug, 50);
  const needle = companySlug.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matched = hits.filter(
    (h) =>
      h.companyName.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle) ||
      h.boardSlug === companySlug,
  );
  if (matched.length === 0) return null;
  return matched.map(({ title, url, location, team, content, publishedAt }) => ({
    title,
    url,
    location,
    team,
    content,
    publishedAt,
  }));
}

// ---------------------------------------------------------------------------
// Programathor (Brazilian tech job board — HTML list scrape)
// ---------------------------------------------------------------------------

export async function searchProgramathorJobs(
  query: string,
  limit = 30,
): Promise<AggregatedJob[]> {
  const url = `https://programathor.com.br/jobs?s=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  if (!html) return [];

  const blocks = html.split(/<div class="cell-list\s*">/).slice(1);
  const out: AggregatedJob[] = [];

  for (const block of blocks) {
    if (out.length >= limit) break;
    const hrefMatch = block.match(/href="(\/jobs\/\d+-[^"]+)"/);
    if (!hrefMatch) continue;
    const path = hrefMatch[1];
    const text = block
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\n+/g, "\n")
      .trim();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 1);
    // Heuristic: title is first substantial line; company often follows.
    const title =
      lines.find((l) => l.length > 3 && !/^NOVA$/i.test(l)) ?? path;
    // Noise lines (seniority, contract, location labels, pure tech tags)
    const noise =
      /^(remoto|presencial|híbrido|hibrido|júnior|junior|pleno|sênior|senior|pj|clt|estágio|estagio|nova|pequena|grande|média|media|empresa|até|ate|r\$|devops|python|java|react|node|golang|php|sql|aws|azure|go|ruby|kotlin|swift|typescript|javascript)(\/|$|\s)/i;
    const techOnly = /^(#?[\w+#./-]{1,20})$/;
    const titleIdx = lines.indexOf(title);
    const company =
      lines.find((l, idx) => {
        if (idx <= titleIdx) return false;
        if (l === title) return false;
        if (l.length < 2 || l.length > 80) return false;
        if (noise.test(l)) return false;
        // Allow single-token company names (Kommo) but skip pure tech tags
        if (techOnly.test(l) && /^(python|java|react|node|golang|php|sql|aws|azure|go|ruby|devops|typescript|javascript|ios|android)$/i.test(l)) {
          return false;
        }
        return true;
      }) ?? "Unknown";

    const location =
      lines.find((l) =>
        /remoto|presencial|híbrido|hibrido|são paulo|sao paulo|rio de janeiro|belo horizonte|curitiba|brasil/i.test(
          l,
        ),
      ) ?? null;

    const slug = company
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 40);

    out.push({
      title,
      url: `https://programathor.com.br${path}`,
      location,
      team: null,
      content: truncate(lines.join("\n")),
      publishedAt: null,
      companyName: company,
      ats: "programathor",
      boardSlug: slug || path,
    });
  }

  return out;
}

export async function fetchProgramathorCompanyJobs(
  companySlug: string,
): Promise<JobPosting[] | null> {
  // Search by company slug text and filter.
  const hits = await searchProgramathorJobs(companySlug, 40);
  const needle = companySlug.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matched = hits.filter((h) =>
    h.companyName.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle),
  );
  if (matched.length === 0) return null;
  return matched.map(({ title, url, location, team, content, publishedAt }) => ({
    title,
    url,
    location,
    team,
    content,
    publishedAt,
  }));
}

// ---------------------------------------------------------------------------
// LinkedIn Jobs — via search engines + light public-page scrape
//
// We never log into LinkedIn. Flow:
// 1) DuckDuckGo HTML (and optional Exa) for site:linkedin.com/jobs/view
// 2) Parse company/title from URL slug + og:title / og:description on the
//    public guest job page (works without auth for many postings).
// Fragile by nature; treat as best-effort discovery signal.
// ---------------------------------------------------------------------------

const LI_JOB_ID_RE = /linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i;
const LI_JOB_URL_RE =
  /https?:\/\/(?:[a-z]{2}\.)?linkedin\.com\/jobs\/view\/[^\s"'<>&]+/gi;

function normalizeLinkedInJobUrl(raw: string): string | null {
  let url = raw;
  try {
    url = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  // Strip tracking junk
  url = url.replace(/&amp;/g, "&").split("?")[0].split("#")[0];
  const idMatch = url.match(LI_JOB_ID_RE);
  if (!idMatch) return null;
  return `https://www.linkedin.com/jobs/view/${idMatch[1]}`;
}

/** "qa-automation-at-compass-uol-4439" → company "compass-uol", title words. */
export function parseLinkedInJobSlug(url: string): {
  jobId: string;
  companySlug: string | null;
  titleSlug: string | null;
} | null {
  try {
    const path = new URL(url).pathname;
    const seg = path.split("/").filter(Boolean).pop() ?? "";
    // formats:
    //   4439350576
    //   qa-automation-engineer-at-compass-uol-4439350576
    const m = seg.match(/^(?:(.+)-)?(\d{6,})$/);
    if (!m) return null;
    const jobId = m[2];
    const rest = m[1] ?? null;
    if (!rest) return { jobId, companySlug: null, titleSlug: null };
    const at = rest.lastIndexOf("-at-");
    if (at === -1) {
      return { jobId, companySlug: null, titleSlug: rest };
    }
    return {
      jobId,
      titleSlug: rest.slice(0, at) || null,
      companySlug: rest.slice(at + 4) || null,
    };
  } catch {
    return null;
  }
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type LinkedInListHit = {
  url: string;
  title: string;
  companyName: string;
  location: string | null;
};

/**
 * Primary: LinkedIn public guest search HTML (no login).
 * https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 */
async function searchLinkedInViaGuestApi(opts: {
  query: string;
  location?: string | null;
  limit: number;
}): Promise<LinkedInListHit[]> {
  const params = new URLSearchParams({
    keywords: opts.query,
    start: "0",
  });
  if (opts.location) params.set("location", opts.location);

  const html = await fetchText(
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`,
    { "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8" },
  );
  if (!html || html.length < 200) return [];

  const hrefs = [
    ...html.matchAll(
      /href="(https:\/\/(?:[a-z]{2}\.)?linkedin\.com\/jobs\/view\/[^"?]+)/g,
    ),
  ].map((m) => m[1]);
  const titles = [
    ...html.matchAll(/base-search-card__title[^>]*>\s*([^<]+)/g),
  ].map((m) => m[1].trim());
  const companies = [
    ...html.matchAll(
      /base-search-card__subtitle[^>]*>\s*(?:<a[^>]*>)?\s*([^<\n]+)/g,
    ),
  ].map((m) => m[1].trim());
  const locs = [
    ...html.matchAll(/job-search-card__location[^>]*>\s*([^<\n]+)/g),
  ].map((m) => m[1].trim());

  const n = Math.min(
    opts.limit,
    hrefs.length,
    titles.length || hrefs.length,
    companies.length || hrefs.length,
  );
  const out: LinkedInListHit[] = [];
  for (let i = 0; i < n; i++) {
    const url = normalizeLinkedInJobUrl(hrefs[i]) ?? hrefs[i].split("?")[0];
    out.push({
      url,
      title: titles[i] || "LinkedIn job",
      companyName: companies[i] || "Unknown",
      location: locs[i] || opts.location || null,
    });
  }
  return out;
}

/**
 * Fallback: DuckDuckGo HTML — often captcha'd from datacenter IPs.
 */
async function searchLinkedInJobUrlsViaDdg(
  query: string,
  limit: number,
): Promise<string[]> {
  const q = `site:linkedin.com/jobs/view ${query}`;
  const html = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  );
  if (!html) return [];

  const urls = new Set<string>();
  for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
    try {
      const decoded = decodeURIComponent(m[1]);
      const norm = normalizeLinkedInJobUrl(decoded);
      if (norm) urls.add(norm);
    } catch {
      // skip
    }
  }
  for (const m of html.matchAll(LI_JOB_URL_RE)) {
    const norm = normalizeLinkedInJobUrl(m[0]);
    if (norm) urls.add(norm);
  }
  return [...urls].slice(0, limit);
}

/** Optional Exa when EXA_API_KEY is set. */
async function searchLinkedInJobUrlsViaExa(
  query: string,
  limit: number,
): Promise<string[]> {
  if (!process.env.EXA_API_KEY?.trim()) return [];
  try {
    const { searchUrls } = await import("@/lib/exa");
    const results = await searchUrls({
      query: `${query} linkedin jobs`,
      domains: ["linkedin.com"],
      numResults: limit,
      daysBack: 120,
    });
    const urls: string[] = [];
    for (const r of results) {
      const norm = normalizeLinkedInJobUrl(r.url);
      if (norm) urls.push(norm);
    }
    return urls;
  } catch (err) {
    console.warn("[linkedin] Exa search failed:", err);
    return [];
  }
}

/** Light guest-page scrape: og:title / og:description (no login). */
export async function scrapeLinkedInJobPage(jobUrl: string): Promise<{
  title: string | null;
  companyName: string | null;
  location: string | null;
  content: string;
} | null> {
  const html = await fetchText(jobUrl, {
    "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
  });
  if (!html || html.length < 500) return null;

  const ogTitle =
    html.match(
      /property=["']og:title["']\s+content=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(
      /content=["']([^"']+)["']\s+property=["']og:title["']/i,
    )?.[1] ??
    null;
  const ogDesc =
    html.match(
      /property=["']og:description["']\s+content=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(
      /content=["']([^"']+)["']\s+property=["']og:description["']/i,
    )?.[1] ??
    null;

  // "Compass UOL hiring QA Automation Engineer | Mid-Level (Remote) in Brazil | LinkedIn"
  let companyName: string | null = null;
  let title: string | null = null;
  let location: string | null = null;

  if (ogTitle) {
    const decoded = ogTitle
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    const hiring = decoded.match(
      /^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+?))?\s*\|\s*LinkedIn$/i,
    );
    if (hiring) {
      companyName = hiring[1].trim();
      title = hiring[2].trim();
      location = hiring[3]?.trim() ?? null;
    } else {
      title = decoded.replace(/\s*\|\s*LinkedIn$/i, "").trim();
    }
  }

  const content = truncate(
    htmlToText((ogDesc ?? "").replace(/&amp;/g, "&").replace(/&#39;/g, "'")),
  );

  return { title, companyName, location, content };
}

export async function searchLinkedInJobs(opts: {
  query: string;
  /** e.g. "Brazil" */
  location?: string | null;
  limit?: number;
  /** Fetch og: description for body text. Default true. */
  enrich?: boolean;
}): Promise<AggregatedJob[]> {
  const limit = opts.limit ?? 20;
  const enrich = opts.enrich !== false;

  // 1) Guest search API (best signal, no key)
  let list = await searchLinkedInViaGuestApi({
    query: opts.query,
    location: opts.location,
    limit,
  });

  // 2) Fallbacks if guest is blocked: Exa + DDG URL harvest
  if (list.length === 0) {
    const q = [opts.query, opts.location].filter(Boolean).join(" ");
    const [exaUrls, ddgUrls] = await Promise.all([
      searchLinkedInJobUrlsViaExa(q, limit),
      searchLinkedInJobUrlsViaDdg(q, limit),
    ]);
    const urls = [...new Set([...exaUrls, ...ddgUrls])].slice(0, limit);
    list = urls.map((url) => {
      const parsed = parseLinkedInJobSlug(url);
      return {
        url,
        title: parsed?.titleSlug
          ? humanizeSlug(parsed.titleSlug)
          : "LinkedIn job",
        companyName: parsed?.companySlug
          ? humanizeSlug(parsed.companySlug)
          : "Unknown",
        location: opts.location ?? null,
      };
    });
  }

  const out: AggregatedJob[] = [];
  for (const hit of list.slice(0, limit)) {
    let { title, companyName, location, url } = hit;
    let content = "";

    if (enrich) {
      try {
        const page = await scrapeLinkedInJobPage(url);
        if (page) {
          // Prefer guest-list title; og:title is often a localized
          // "Company is hiring for role…" template.
          if (
            page.title &&
            !/^a empresa\b/i.test(page.title) &&
            !/\bestá contratando\b/i.test(page.title)
          ) {
            title = page.title;
          }
          if (page.companyName) companyName = page.companyName;
          if (page.location && !/ in /i.test(page.location)) {
            location = page.location;
          }
          content = page.content;
        }
        await new Promise((r) => setTimeout(r, 150));
      } catch {
        // keep list fields
      }
    }

    if (!companyName || companyName === "Unknown") continue;

    const boardSlug = companyName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 40);

    const parsed = parseLinkedInJobSlug(url);
    out.push({
      title,
      url,
      location,
      team: null,
      content,
      publishedAt: null,
      companyName,
      ats: "linkedin",
      boardSlug: boardSlug || `li-${parsed?.jobId ?? "job"}`,
    });
  }

  return out;
}

export async function fetchLinkedInCompanyJobs(
  companySlug: string,
): Promise<JobPosting[] | null> {
  // Re-search LinkedIn for this company name; filter by slug match.
  const name = humanizeSlug(companySlug);
  const hits = await searchLinkedInJobs({
    query: `${name} QA OR SDET OR automation OR engineer`,
    limit: 15,
    enrich: true,
  });
  const needle = companySlug.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matched = hits.filter((h) =>
    h.companyName.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle),
  );
  if (matched.length === 0) return null;
  return matched.map(({ title, url, location, team, content, publishedAt }) => ({
    title,
    url,
    location,
    team,
    content,
    publishedAt,
  }));
}

// ---------------------------------------------------------------------------
// Unified fetch / detect
// ---------------------------------------------------------------------------

export async function fetchBoardJobs(
  ats: AtsProvider,
  slug: string,
): Promise<JobPosting[] | null> {
  switch (ats) {
    case "greenhouse":
      return fetchGreenhouseJobs(slug);
    case "lever":
      return fetchLeverJobs(slug);
    case "ashby":
      return fetchAshbyJobs(slug);
    case "gupy":
      return fetchGupyCompanyJobs(slug);
    case "workable":
      return fetchWorkableJobs(slug);
    case "smartrecruiters":
      return fetchSmartRecruitersJobs(slug);
    case "programathor":
      return fetchProgramathorCompanyJobs(slug);
    case "remotive":
      return fetchRemotiveCompanyJobs(slug);
    case "linkedin":
      return fetchLinkedInCompanyJobs(slug);
  }
}

export function boardPublicUrl(ats: AtsProvider, slug: string): string {
  switch (ats) {
    case "greenhouse":
      return `https://boards.greenhouse.io/${slug}`;
    case "lever":
      return `https://jobs.lever.co/${slug}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${slug}`;
    case "gupy":
      return `https://portal.gupy.io/job-search/term=${encodeURIComponent(slug)}`;
    case "workable":
      return `https://apply.workable.com/${slug}/`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${slug}`;
    case "programathor":
      return `https://programathor.com.br/jobs?s=${encodeURIComponent(slug)}`;
    case "remotive":
      return `https://remotive.com/remote-jobs?search=${encodeURIComponent(slug)}`;
    case "linkedin":
      return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(slug)}`;
  }
}

// Given a company name/domain, guess board slugs and probe each ATS until one
// answers with a live board. Returns the first hit.
export async function detectBoard(input: {
  companyName: string;
  domain?: string | null;
}): Promise<{ ats: AtsProvider; slug: string; jobCount: number } | null> {
  const candidates = new Set<string>();
  const fromName = input.companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  const fromNameDashed = input.companyName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (fromName) candidates.add(fromName);
  if (fromNameDashed) candidates.add(fromNameDashed);
  // Capitalized SmartRecruiters-style identifier
  if (input.companyName.trim()) {
    candidates.add(input.companyName.trim().replace(/\s+/g, ""));
  }
  if (input.domain) {
    const base = input.domain
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(".")[0]
      ?.toLowerCase();
    if (base) candidates.add(base);
  }

  for (const slug of candidates) {
    for (const ats of SLUG_PROBE_ATS) {
      const jobs = await fetchBoardJobs(ats, slug);
      if (jobs && jobs.length > 0) {
        return { ats, slug, jobCount: jobs.length };
      }
    }
  }

  // Gupy filters by exact career-page name, not subdomain slug.
  const gupyJobs = await fetchGupyCompanyJobs(input.companyName);
  if (gupyJobs && gupyJobs.length > 0) {
    return { ats: "gupy", slug: input.companyName, jobCount: gupyJobs.length };
  }
  return null;
}
