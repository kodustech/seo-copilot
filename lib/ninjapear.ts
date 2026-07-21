// NinjaPear (Nubela) B2B data API client — firmographics, employee search,
// person profile (employment history), work-email lookup.
// Credit-billed per call; every wrapper is gated on NINJAPEAR_API_KEY and
// callers must treat failures as soft (waterfall to the next provider).
// Docs: https://nubela.co/llms-full.txt

const HOST = "https://nubela.co";

export function ninjapearEnabled(): boolean {
  return Boolean(process.env.NINJAPEAR_API_KEY?.trim());
}

function normalizeWebsite(website: string): string {
  const t = website.trim();
  if (!t) return t;
  return t.includes("://") ? t : `https://${t}`;
}

function bareDomain(website: string): string {
  return website
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase();
}

async function npFetch<T>(
  apiPath: string,
  params: Record<string, string | undefined | null>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const key = process.env.NINJAPEAR_API_KEY?.trim();
  if (!key) throw new Error("NINJAPEAR_API_KEY not configured");
  const url = new URL(`${HOST}${apiPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v).trim() !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  // Docs: most endpoints 30–60s; use 100s read timeout. Profile can be slow.
  const timeoutMs = opts?.timeoutMs ?? 100_000;
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `NinjaPear ${apiPath} HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

export type NinjapearCompany = {
  name: string | null;
  description: string | null;
  industry: number | null;
  company_type: string | null;
  founded_year: number | null;
  specialties: string[];
  employee_count: number | null;
  websites: string[];
  addresses: Array<{
    address_type: string;
    city: string | null;
    state: string | null;
    country_code: string | null;
    country: string | null;
    is_primary: boolean;
  }>;
  executives: Array<{
    name: string;
    title: string | null;
    role: string | null;
    /** Prefill URL to Person Profile (v2) — call with bearer to enrich. */
    person_profile_url: string | null;
  }>;
  public_listing: { stock_symbol?: string | null } | null;
};

/** Company Details — 3 credits (no optional flags). */
export async function getCompanyDetails(
  website: string,
): Promise<NinjapearCompany> {
  const raw = await npFetch<Record<string, unknown>>("/api/v1/company/details", {
    website: normalizeWebsite(website),
  });
  const executivesRaw = Array.isArray(raw.executives)
    ? (raw.executives as Array<Record<string, unknown>>)
    : [];
  return {
    name: (raw.name as string) ?? null,
    description: (raw.description as string) ?? null,
    industry: typeof raw.industry === "number" ? raw.industry : null,
    company_type: (raw.company_type as string) ?? null,
    founded_year:
      typeof raw.founded_year === "number" ? raw.founded_year : null,
    specialties: Array.isArray(raw.specialties)
      ? (raw.specialties as string[])
      : [],
    employee_count:
      typeof raw.employee_count === "number" ? raw.employee_count : null,
    websites: Array.isArray(raw.websites) ? (raw.websites as string[]) : [],
    addresses: Array.isArray(raw.addresses)
      ? (raw.addresses as NinjapearCompany["addresses"])
      : [],
    executives: executivesRaw.map((e) => ({
      name: String(e.name ?? ""),
      title: (e.title as string) ?? null,
      role: (e.role as string) ?? null,
      person_profile_url: (e.person_profile_url as string) ?? null,
    })),
    public_listing:
      (raw.public_listing as NinjapearCompany["public_listing"]) ?? null,
  };
}

/** Employee Count — 2 credits. Fallback when details returns no count. */
export async function getEmployeeCount(
  website: string,
): Promise<number | null> {
  const data = await npFetch<{ employee_count?: number | null }>(
    "/api/v1/company/employee-count",
    { website: normalizeWebsite(website) },
  );
  return typeof data.employee_count === "number" ? data.employee_count : null;
}

export type NinjapearEmployee = {
  first_name: string;
  last_name: string | null;
  role: string;
  company_website: string;
  /** Prefill Person Profile URL (auth required). */
  person_profile: string | null;
  /** Prefill Work Email URL (auth required). */
  work_email_url: string | null;
};

/** Employee Search — 2 credits + 1 per returned employee. */
export async function searchEmployees(input: {
  companyWebsite: string;
  role: string;
  country?: string | null;
}): Promise<NinjapearEmployee[]> {
  const params: Record<string, string> = {
    company_website: bareDomain(input.companyWebsite) || input.companyWebsite,
    role: input.role,
  };
  if (input.country) params.country = input.country;
  const data = await npFetch<{
    employees?: Array<Record<string, unknown>>;
  }>("/api/v1/employee/search", params);

  return (data.employees ?? []).map((e) => ({
    first_name: String(e.first_name ?? ""),
    last_name: (e.last_name as string) ?? null,
    role: String(e.role ?? ""),
    company_website: String(e.company_website ?? input.companyWebsite),
    person_profile: (e.person_profile as string) ?? null,
    work_email_url: (e.work_email as string) ?? null,
  }));
}

/** Work Email — 2 credits on hit, 0.5 on miss. */
export async function findWorkEmail(input: {
  firstName: string;
  lastName?: string | null;
  domain: string;
}): Promise<string | null> {
  const params: Record<string, string> = {
    first_name: input.firstName,
    domain: bareDomain(input.domain) || input.domain,
  };
  if (input.lastName) params.last_name = input.lastName;
  const data = await npFetch<{ work_email?: string | null }>(
    "/api/v1/employee/work-email",
    params,
  );
  return data.work_email ?? null;
}

export type NinjapearWorkExperience = {
  role: string | null;
  company_name: string | null;
  company_website: string | null;
  description: string | null;
  start_date: string | null;
  /** null = currently in role */
  end_date: string | null;
};

export type NinjapearPersonProfile = {
  id: string | null;
  slug: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  bio: string | null;
  x_handle: string | null;
  x_profile_url: string | null;
  personal_website: string | null;
  work_experience: NinjapearWorkExperience[];
  education: Array<{
    major: string | null;
    school: string | null;
    start_date: string | null;
    end_date: string | null;
  }>;
};

/**
 * Person Profile v2 — 3 credits / request (charged even on empty/404 data).
 *
 * Valid combos (docs):
 * - work_email alone
 * - first_name + employer_website
 * - employer_website + role
 * - slug or id
 *
 * Does NOT return linkedin.com/in URLs — employment history + X + bio only.
 */
export async function getPersonProfile(input: {
  workEmail?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  employerWebsite?: string | null;
  role?: string | null;
  location?: string | null;
  enrichment?: "fast" | "detailed";
}): Promise<NinjapearPersonProfile> {
  const hasEmail = Boolean(input.workEmail?.trim());
  const hasNameEmployer =
    Boolean(input.firstName?.trim()) && Boolean(input.employerWebsite?.trim());
  const hasRoleEmployer =
    Boolean(input.role?.trim()) && Boolean(input.employerWebsite?.trim());
  if (!hasEmail && !hasNameEmployer && !hasRoleEmployer) {
    throw new Error(
      "getPersonProfile requires workEmail, or firstName+employerWebsite, or role+employerWebsite",
    );
  }

  const raw = await npFetch<Record<string, unknown>>(
    "/api/v2/employee/profile",
    {
      work_email: input.workEmail,
      first_name: input.firstName,
      last_name: input.lastName,
      middle_name: input.middleName,
      employer_website: input.employerWebsite
        ? normalizeWebsite(input.employerWebsite)
        : null,
      role: input.role,
      location: input.location,
      enrichment: input.enrichment ?? "fast",
    },
  );

  const workExp = Array.isArray(raw.work_experience)
    ? (raw.work_experience as Array<Record<string, unknown>>)
    : [];
  const education = Array.isArray(raw.education)
    ? (raw.education as Array<Record<string, unknown>>)
    : [];

  return {
    id: (raw.id as string) ?? null,
    slug: (raw.slug as string) ?? null,
    first_name: (raw.first_name as string) ?? null,
    last_name: (raw.last_name as string) ?? null,
    full_name: (raw.full_name as string) ?? null,
    bio: (raw.bio as string) ?? null,
    x_handle: (raw.x_handle as string) ?? null,
    x_profile_url: (raw.x_profile_url as string) ?? null,
    personal_website: (raw.personal_website as string) ?? null,
    work_experience: workExp.map((w) => ({
      role: (w.role as string) ?? null,
      company_name: (w.company_name as string) ?? null,
      company_website: (w.company_website as string) ?? null,
      description: (w.description as string) ?? null,
      start_date: (w.start_date as string) ?? null,
      end_date: (w.end_date as string) ?? null,
    })),
    education: education.map((e) => ({
      major: (e.major as string) ?? null,
      school: (e.school as string) ?? null,
      start_date: (e.start_date as string) ?? null,
      end_date: (e.end_date as string) ?? null,
    })),
  };
}

function brandToken(domainOrHost: string): string | null {
  const host = bareDomain(domainOrHost);
  const parts = host.split(".").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length < 2) return parts[0] ?? null;
  if (parts[parts.length - 1].length === 2 && parts.length >= 3) {
    return parts[parts.length - 3] ?? parts[0];
  }
  return parts[parts.length - 2] ?? parts[0];
}

function websiteMatchesEmployer(
  companyWebsite: string | null | undefined,
  targetDomain: string,
): boolean {
  if (!companyWebsite) return false;
  const a = bareDomain(companyWebsite);
  const b = bareDomain(targetDomain);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const ba = brandToken(a);
  const bb = brandToken(b);
  return Boolean(ba && bb && ba === bb && ba.length >= 3);
}

function companyNameMatches(
  companyName: string | null | undefined,
  targetName: string | null | undefined,
): boolean {
  if (!companyName || !targetName) return false;
  const a = companyName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const b = targetName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

export type EmploymentMatch = {
  ok: boolean;
  /** True when match is a current role (end_date null). */
  current: boolean;
  role: string | null;
  companyName: string | null;
  companyWebsite: string | null;
  evidence: string;
};

/**
 * Check Person Profile work_experience against target employer.
 * Prefers current roles (end_date null); falls back to any past match.
 */
export function matchEmploymentAtCompany(
  profile: NinjapearPersonProfile,
  input: { domain: string; companyName?: string | null },
): EmploymentMatch {
  const experiences = profile.work_experience ?? [];
  if (experiences.length === 0) {
    return {
      ok: false,
      current: false,
      role: null,
      companyName: null,
      companyWebsite: null,
      evidence: "no work_experience",
    };
  }

  const scored = experiences.map((exp, i) => {
    const bySite = websiteMatchesEmployer(exp.company_website, input.domain);
    const byName = companyNameMatches(exp.company_name, input.companyName);
    const current = exp.end_date == null;
    let score = 0;
    const hits: string[] = [];
    if (bySite) {
      score += 50;
      hits.push(`website:${exp.company_website}`);
    }
    if (byName) {
      score += 30;
      hits.push(`name:${exp.company_name}`);
    }
    if (current && score > 0) {
      score += 20;
      hits.push("current");
    }
    // Recency bonus for earlier entries (API returns most recent first)
    if (score > 0) score += Math.max(0, 5 - i);
    return { exp, score, hits, current };
  });

  const best = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  if (!best) {
    return {
      ok: false,
      current: false,
      role: null,
      companyName: null,
      companyWebsite: null,
      evidence: "employer not in work_experience",
    };
  }

  return {
    ok: true,
    current: best.current,
    role: best.exp.role,
    companyName: best.exp.company_name,
    companyWebsite: best.exp.company_website,
    evidence: best.hits.join("; "),
  };
}

/**
 * Soft person lookup + employment check. Returns null on any failure
 * (missing key, 404, network) so waterfalls stay non-blocking.
 */
export async function lookupPersonEmployment(input: {
  domain: string;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  workEmail?: string | null;
  role?: string | null;
}): Promise<{
  profile: NinjapearPersonProfile;
  employment: EmploymentMatch;
} | null> {
  if (!ninjapearEnabled()) return null;
  try {
    const profile = await getPersonProfile({
      workEmail: input.workEmail,
      firstName: input.firstName,
      lastName: input.lastName,
      employerWebsite: input.domain,
      role: input.role,
      enrichment: "fast",
    });
    const employment = matchEmploymentAtCompany(profile, {
      domain: input.domain,
      companyName: input.companyName,
    });
    return { profile, employment };
  } catch (err) {
    console.warn("[ninjapear] person profile failed:", err);
    return null;
  }
}

/** Split "Jane Marie Doe" → first / last for API params. */
export function splitPersonName(fullName: string): {
  firstName: string;
  lastName: string | null;
} {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}
