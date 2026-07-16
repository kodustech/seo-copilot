// NinjaPear (Nubela) B2B data API client — firmographics, employee search,
// work-email lookup. Credit-billed per call, so every wrapper is gated on
// NINJAPEAR_API_KEY and callers must treat failures as soft (waterfall to
// the next provider).
// Docs: https://nubela.co/llms-full.txt

const BASE = "https://nubela.co/api/v1";

export function ninjapearEnabled(): boolean {
  return Boolean(process.env.NINJAPEAR_API_KEY?.trim());
}

async function npFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.NINJAPEAR_API_KEY?.trim();
  if (!key) throw new Error("NINJAPEAR_API_KEY not configured");
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(45_000), // company details averages ~8s, can spike
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NinjaPear ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
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
  }>;
  public_listing: { stock_symbol?: string | null } | null;
};

/** Company Details — 3 credits (no optional flags). */
export async function getCompanyDetails(
  website: string,
): Promise<NinjapearCompany> {
  const raw = await npFetch<Record<string, unknown>>("/company/details", {
    website: website.includes("://") ? website : `https://${website}`,
  });
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
    executives: Array.isArray(raw.executives)
      ? (raw.executives as NinjapearCompany["executives"])
      : [],
    public_listing:
      (raw.public_listing as NinjapearCompany["public_listing"]) ?? null,
  };
}

/** Employee Count — 2 credits. Fallback when details returns no count. */
export async function getEmployeeCount(
  website: string,
): Promise<number | null> {
  const data = await npFetch<{ employee_count?: number | null }>(
    "/company/employee-count",
    { website: website.includes("://") ? website : `https://${website}` },
  );
  return typeof data.employee_count === "number" ? data.employee_count : null;
}

export type NinjapearEmployee = {
  first_name: string;
  last_name: string | null;
  role: string;
  company_website: string;
};

/** Employee Search — 2 credits + 1 per returned employee. */
export async function searchEmployees(input: {
  companyWebsite: string;
  role: string;
  country?: string | null;
}): Promise<NinjapearEmployee[]> {
  const params: Record<string, string> = {
    company_website: input.companyWebsite,
    role: input.role,
  };
  if (input.country) params.country = input.country;
  const data = await npFetch<{ employees?: NinjapearEmployee[] }>(
    "/employee/search",
    params,
  );
  return data.employees ?? [];
}

/** Work Email — 2 credits on hit, 0.5 on miss. */
export async function findWorkEmail(input: {
  firstName: string;
  lastName?: string | null;
  domain: string;
}): Promise<string | null> {
  const params: Record<string, string> = {
    first_name: input.firstName,
    domain: input.domain,
  };
  if (input.lastName) params.last_name = input.lastName;
  const data = await npFetch<{ work_email?: string | null }>(
    "/employee/work-email",
    params,
  );
  return data.work_email ?? null;
}
