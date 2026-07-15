import type { PackOutput } from "@/lib/research/types";
import {
  getCompanyDetails,
  getEmployeeCount,
  ninjapearEnabled,
} from "@/lib/ninjapear";

/**
 * Firmographics pack (NinjaPear Company Details, 3 credits/company):
 * real headcount, industry, founded year, HQ country, leadership.
 * Replaces the weak "open job postings" proxy for company size.
 */
export async function runFirmoPack(input: {
  companyName: string;
  domain: string | null;
}): Promise<PackOutput> {
  const pack = "firmo";

  if (!ninjapearEnabled()) {
    return {
      pack,
      ok: false,
      error: "NINJAPEAR_API_KEY not configured",
      snippets: [],
    };
  }
  if (!input.domain) {
    return {
      pack,
      ok: false,
      error: "no domain — cannot fetch firmographics",
      snippets: [],
    };
  }

  try {
    const company = await getCompanyDetails(input.domain);
    const hq =
      company.addresses.find((a) => a.is_primary) ?? company.addresses[0];

    // Details often omits headcount; the dedicated endpoint (2 credits)
    // fills it since team size is usually a scoring criterion.
    if (company.employee_count == null) {
      try {
        company.employee_count = await getEmployeeCount(input.domain);
      } catch (err) {
        console.warn("[firmo] employee-count fallback failed:", err);
      }
    }

    // Rough dev-team estimate: eng is typically 20-40% of a software
    // company's headcount. Given as a range so the scorer treats it as a
    // hint, not a fact.
    const devEstimate = company.employee_count
      ? {
          min: Math.round(company.employee_count * 0.2),
          max: Math.round(company.employee_count * 0.4),
        }
      : null;

    const lines = [
      company.description,
      company.employee_count != null
        ? `Employee count: ${company.employee_count}${devEstimate ? ` (estimated dev team: ~${devEstimate.min}-${devEstimate.max})` : ""}`
        : null,
      company.company_type ? `Company type: ${company.company_type}` : null,
      company.founded_year ? `Founded: ${company.founded_year}` : null,
      company.specialties.length
        ? `Specialties: ${company.specialties.join(", ")}`
        : null,
      hq ? `HQ: ${[hq.city, hq.state, hq.country].filter(Boolean).join(", ")}` : null,
      company.executives.length
        ? `Leadership: ${company.executives
            .slice(0, 6)
            .map((e) => `${e.name} (${e.title ?? e.role ?? "?"})`)
            .join("; ")}`
        : null,
    ].filter(Boolean);

    return {
      pack,
      ok: true,
      snippets: [
        {
          url: `https://${input.domain}`,
          title: `${company.name ?? input.companyName} — firmographics`,
          text: lines.join("\n"),
        },
      ],
      meta: {
        employeeCount: company.employee_count,
        devTeamEstimate: devEstimate,
        industryGics: company.industry,
        companyType: company.company_type,
        foundedYear: company.founded_year,
        specialties: company.specialties,
        hqCountry: hq?.country_code ?? null,
        isPublicCompany: Boolean(company.public_listing),
        executives: company.executives.slice(0, 6),
        provider: "ninjapear",
      },
    };
  } catch (err) {
    return {
      pack,
      ok: false,
      error: err instanceof Error ? err.message : "firmo pack failed",
      snippets: [],
    };
  }
}
