// Public ATS job-board collectors. Greenhouse, Lever and Ashby all expose
// their hosted job boards as unauthenticated JSON APIs, so signal collection
// here is free — no Exa credits, no scraping. Each collector normalizes into
// a common JobPosting shape for the classifier.

export type AtsProvider = "greenhouse" | "lever" | "ashby";

export const ATS_PROVIDERS: AtsProvider[] = ["greenhouse", "lever", "ashby"];

export type JobPosting = {
  title: string;
  url: string;
  location: string | null;
  team: string | null;
  content: string; // plain text, truncated
  publishedAt: string | null;
};

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 6_000;

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Greenhouse returns job content as HTML-escaped HTML; flatten to plain text.
function htmlToText(html: string): string {
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
  return text.length > MAX_CONTENT_CHARS ? text.slice(0, MAX_CONTENT_CHARS) : text;
}

export async function fetchGreenhouseJobs(slug: string): Promise<JobPosting[] | null> {
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  );
  if (!data || typeof data !== "object" || !Array.isArray((data as { jobs?: unknown }).jobs)) {
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

export async function fetchAshbyJobs(slug: string): Promise<JobPosting[] | null> {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
  );
  if (!data || typeof data !== "object" || !Array.isArray((data as { jobs?: unknown }).jobs)) {
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
      content: truncate(j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? "")),
      publishedAt: j.publishedAt ?? null,
    }));
}

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
  if (input.domain) {
    const base = input.domain
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(".")[0]
      ?.toLowerCase();
    if (base) candidates.add(base);
  }

  for (const slug of candidates) {
    for (const ats of ATS_PROVIDERS) {
      const jobs = await fetchBoardJobs(ats, slug);
      if (jobs && jobs.length > 0) {
        return { ats, slug, jobCount: jobs.length };
      }
    }
  }
  return null;
}
