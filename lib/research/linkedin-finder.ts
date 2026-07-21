/**
 * Resolve a LinkedIn profile for a person and **verify they work at the target company**.
 * Name-only matches are rejected — we require company/domain evidence in title/snippet/page text.
 */

import { searchWebContent, scrapePageContent } from "@/lib/exa";

export type LinkedInMatch = {
  url: string;
  title: string;
  confidence: number;
  evidence: string;
  companyMatch: boolean;
};

const STOP = new Set([
  "the",
  "and",
  "for",
  "inc",
  "llc",
  "ltd",
  "sa",
  "s.a",
  "ltda",
  "corp",
  "co",
  "company",
  "group",
  "brasil",
  "brazil",
  "of",
  "de",
  "da",
  "do",
  "dos",
  "das",
  "e",
  "com",
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(/[\s./-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function domainBrand(domain: string | null): string | null {
  if (!domain) return null;
  const host = domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? null;
  // acme.com.br → acme; acme.com → acme
  if (parts[parts.length - 1].length === 2 && parts.length >= 3) {
    return parts[parts.length - 3] ?? parts[0];
  }
  return parts[parts.length - 2] ?? parts[0];
}

function isPersonLinkedInUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.replace(/^www\./, "").endsWith("linkedin.com")) return false;
    return /\/in\/[^/]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

function normalizeLinkedInUrl(url: string): string {
  try {
    const u = new URL(url.split("?")[0]);
    const m = u.pathname.match(/\/in\/([^/]+)/i);
    if (!m) return url;
    return `https://www.linkedin.com/in/${m[1].toLowerCase()}`;
  } catch {
    return url;
  }
}

function nameMatches(blob: string, name: string): boolean {
  const nameToks = tokens(name);
  if (nameToks.length === 0) return false;
  // Require first + last when available
  if (nameToks.length >= 2) {
    return nameToks.slice(0, 2).every((t) => blob.includes(t));
  }
  return blob.includes(nameToks[0]);
}

function companyEvidence(
  blob: string,
  companyName: string,
  domain: string | null,
): { ok: boolean; evidence: string } {
  const companyToks = tokens(companyName);
  const brand = domainBrand(domain);
  const hits: string[] = [];

  // Full-ish company name chunk
  const companyNorm = normalize(companyName);
  if (companyNorm.length >= 4 && blob.includes(companyNorm)) {
    hits.push(`company:"${companyName}"`);
  }

  // Domain brand (strong signal on LI titles: "Engineer at Acme")
  if (brand && brand.length >= 3 && blob.includes(brand)) {
    hits.push(`domain_brand:${brand}`);
  }

  // Majority of significant company tokens
  if (companyToks.length >= 2) {
    const matched = companyToks.filter((t) => blob.includes(t));
    if (matched.length >= Math.ceil(companyToks.length * 0.6)) {
      hits.push(`tokens:${matched.join(",")}`);
    }
  } else if (companyToks.length === 1 && blob.includes(companyToks[0])) {
    hits.push(`token:${companyToks[0]}`);
  }

  // "at Company" / "· Company" patterns
  for (const t of [...companyToks, brand].filter(Boolean) as string[]) {
    if (
      new RegExp(
        `\\b(at|@|na|no|em|\\·|\\||-|–)\\s+${t}\\b`,
        "i",
      ).test(blob)
    ) {
      hits.push(`at:${t}`);
    }
  }

  return { ok: hits.length > 0, evidence: hits.join("; ") || "no company signal" };
}

/**
 * Find a LinkedIn /in/ profile for this person that shows they work at company.
 * Returns null if no verified match (never return a name-only hit).
 */
export async function findVerifiedLinkedIn(input: {
  name: string;
  companyName: string;
  domain: string | null;
  role?: string | null;
}): Promise<LinkedInMatch | null> {
  const name = input.name.trim();
  const company = input.companyName.trim();
  if (!name || !company) return null;

  const brand = domainBrand(input.domain);
  const queries = [
    `"${name}" "${company}" site:linkedin.com/in`,
    brand
      ? `"${name}" ${brand} site:linkedin.com/in`
      : `"${name}" "${company}" linkedin`,
    input.role
      ? `"${name}" "${input.role}" "${company}" site:linkedin.com/in`
      : null,
  ].filter(Boolean) as string[];

  type Cand = {
    url: string;
    title: string;
    blob: string;
    score: number;
    evidence: string;
  };
  const cands: Cand[] = [];

  for (const query of queries) {
    try {
      const { results } = await searchWebContent({
        query,
        domains: ["linkedin.com"],
        numResults: 6,
        daysBack: 0, // no date filter — LinkedIn profiles are evergreen
        textMaxCharacters: 2500,
      });
      for (const r of results) {
        if (!isPersonLinkedInUrl(r.url)) continue;
        const url = normalizeLinkedInUrl(r.url);
        const blob = normalize(
          [r.title, r.summary, ...(r.highlights ?? []), r.text ?? ""].join(
            " ",
          ),
        );
        if (!nameMatches(blob, name)) continue;
        const ce = companyEvidence(blob, company, input.domain);
        if (!ce.ok) continue;

        let score = 40 + (r.score ?? 0) * 20;
        if (ce.evidence.includes("company:")) score += 25;
        if (ce.evidence.includes("domain_brand:")) score += 20;
        if (ce.evidence.includes("at:")) score += 15;
        if (input.role) {
          const roleToks = tokens(input.role);
          const roleHits = roleToks.filter((t) => blob.includes(t)).length;
          score += roleHits * 5;
        }
        cands.push({
          url,
          title: r.title,
          blob,
          score,
          evidence: ce.evidence,
        });
      }
    } catch (err) {
      console.warn("[linkedin-finder] search failed:", err);
    }
  }

  if (cands.length === 0) return null;

  // Dedupe by url, keep best score
  const byUrl = new Map<string, Cand>();
  for (const c of cands) {
    const prev = byUrl.get(c.url);
    if (!prev || c.score > prev.score) byUrl.set(c.url, c);
  }
  const ranked = [...byUrl.values()].sort((a, b) => b.score - a.score);
  let best = ranked[0];

  // Optional: scrape top profile-ish page for stronger company proof when score borderline
  if (best.score < 70) {
    try {
      const page = await scrapePageContent({
        url: best.url,
        maxCharacters: 4000,
        includeSummary: true,
      });
      const pageBlob = normalize(
        [page.title ?? "", page.summary ?? "", page.text ?? ""].join(" "),
      );
      if (nameMatches(pageBlob, name)) {
        const ce = companyEvidence(pageBlob, company, input.domain);
        if (ce.ok) {
          best = {
            ...best,
            score: best.score + 20,
            evidence: `${best.evidence}; page:${ce.evidence}`,
          };
        } else {
          // Scraped page does not confirm company — reject
          return null;
        }
      }
    } catch {
      // keep search-only match if already has company evidence
    }
  }

  // Absolute floor: company evidence was required to enter cands
  const confidence = Math.min(0.95, 0.45 + best.score / 150);
  if (confidence < 0.5) return null;

  return {
    url: best.url,
    title: best.title,
    confidence,
    evidence: best.evidence,
    companyMatch: true,
  };
}

/**
 * Validate an existing LinkedIn URL against company. Reject invents/wrong people.
 */
export async function verifyLinkedInBelongsToCompany(input: {
  url: string;
  name: string;
  companyName: string;
  domain: string | null;
}): Promise<{ ok: boolean; evidence: string; confidence: number }> {
  if (!isPersonLinkedInUrl(input.url)) {
    return { ok: false, evidence: "not a /in/ profile URL", confidence: 0 };
  }
  try {
    const page = await scrapePageContent({
      url: input.url,
      maxCharacters: 4000,
      includeSummary: true,
    });
    const blob = normalize(
      [page.title ?? "", page.summary ?? "", page.text ?? ""].join(" "),
    );
    if (!nameMatches(blob, input.name)) {
      return { ok: false, evidence: "name not found on profile", confidence: 0 };
    }
    const ce = companyEvidence(blob, input.companyName, input.domain);
    if (!ce.ok) {
      return {
        ok: false,
        evidence: "company/domain not found on profile",
        confidence: 0,
      };
    }
    return { ok: true, evidence: ce.evidence, confidence: 0.85 };
  } catch (err) {
    return {
      ok: false,
      evidence: err instanceof Error ? err.message : "scrape failed",
      confidence: 0,
    };
  }
}
