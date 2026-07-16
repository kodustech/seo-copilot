// Company name → website domain waterfall. Discovery sources (Gupy,
// LinkedIn, Programathor…) usually give us a company name but no domain,
// which blinds the product/pain packs, the research cache, and the people
// waterfall. This resolves the domain once and caches it for 30 days.

import type { SupabaseClient } from "@supabase/supabase-js";

import { searchUrls } from "@/lib/exa";
import { normalizeDomain } from "@/lib/crm";
import { getCached, setCache } from "@/lib/research/cache";

export type ResolvedDomain = {
  domain: string | null;
  source: "cache" | "hint" | "exa" | "none";
  confidence: number;
};

// Hosts that can never be a company's own website.
const BLOCKED_HOST_RE =
  /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|glassdoor\.com(\.br)?|indeed\.com(\.br)?|crunchbase\.com|wikipedia\.org|github\.com|medium\.com|gupy\.io|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|programathor\.com\.br|remotive\.(com|io)|vagas\.com\.br|catho\.com\.br|infojobs\.com\.br|trampos\.co|apinfo\.com|bloomberg\.com|reuters\.com|g1\.globo\.com|exame\.com|startupi\.com\.br|techcrunch\.com|angel\.co|wellfound\.com|zoominfo\.com|apollo\.io|clearbit\.com)$/i;

function nameTokens(companyName: string): string[] {
  return companyName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(ltda|s\.?a\.?|inc|llc|corp|tecnologia|technologies|software|group|holding|brasil|brazil)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Compact alphanumeric form of the name — fallback for acronyms ("CI&T" → "cit"). */
function compactName(companyName: string): string {
  return companyName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** How well a domain matches the company name (0..1). */
export function domainNameAffinity(
  domain: string,
  companyName: string,
): number {
  const host = domain.toLowerCase().replace(/^www\./, "");
  const base = host.split(".")[0];
  const tokens = nameTokens(companyName);
  if (tokens.length === 0) {
    // Acronyms/short names ("CI&T", "XP"): compare compact forms directly.
    const compact = compactName(companyName);
    if (compact.length < 2) return 0;
    if (base === compact) return 0.9;
    if (base.replace(/and/g, "").includes(compact) || compact.includes(base)) {
      return 0.6;
    }
    return 0;
  }

  const compact = tokens.join("");
  if (base === compact || host.startsWith(`${compact}.`)) return 1;
  if (tokens.some((t) => base === t)) return 0.9;
  if (tokens.some((t) => base.includes(t) || t.includes(base))) return 0.7;
  // All tokens appear somewhere in the host
  if (tokens.every((t) => host.includes(t))) return 0.6;
  return 0;
}

async function isReachable(domain: string): Promise<boolean> {
  for (const proto of ["https", "http"]) {
    try {
      const res = await fetch(`${proto}://${domain}`, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok || (res.status >= 300 && res.status < 500)) return true;
    } catch {
      // try next protocol
    }
  }
  return false;
}

export function nameCacheKey(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `company:${slug}:domain:v1`;
}

/**
 * Resolve a company's website domain from its name.
 * Waterfall: cache → Exa web search (blocklist + name affinity + reachability).
 */
export async function resolveDomain(
  client: SupabaseClient,
  companyName: string,
  opts: { hintUrl?: string | null } = {},
): Promise<ResolvedDomain> {
  const name = companyName.trim();
  if (!name || name.toLowerCase() === "unknown") {
    return { domain: null, source: "none", confidence: 0 };
  }

  const cacheKey = nameCacheKey(name);
  const cached = await getCached<ResolvedDomain>(client, cacheKey);
  if (cached) return { ...cached, source: "cache" };

  const candidates = new Map<string, number>(); // domain -> best affinity

  const consider = (url: string, rankBoost: number) => {
    const domain = normalizeDomain(url);
    if (!domain || !domain.includes(".")) return;
    if (BLOCKED_HOST_RE.test(domain)) return;
    const affinity = domainNameAffinity(domain, name);
    if (affinity <= 0) return;
    const score = affinity + rankBoost;
    const prev = candidates.get(domain);
    if (prev == null || score > prev) candidates.set(domain, score);
  };

  // Hint from discovery metadata (e.g. og:url from a job page) is cheap — try first.
  if (opts.hintUrl) consider(opts.hintUrl, 0.1);

  let searchRan = false;
  if (process.env.EXA_API_KEY?.trim()) {
    const queries = [
      `${name} official website`,
      `${name} site oficial empresa`,
    ];
    for (const query of queries) {
      try {
        const results = await searchUrls({
          query,
          numResults: 8,
          daysBack: null,
        });
        searchRan = true;
        results.forEach((r, i) => consider(r.url, (8 - i) * 0.01));
      } catch (err) {
        console.warn(`[domain-resolver] Exa failed for "${query}":`, err);
      }
      // First query usually suffices when we already have strong candidates.
      if ([...candidates.values()].some((s) => s >= 0.9)) break;
    }
  }

  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]);

  for (const [domain, score] of ranked.slice(0, 3)) {
    if (await isReachable(domain)) {
      const resolved: ResolvedDomain = {
        domain,
        source: searchRan ? "exa" : "hint",
        confidence: Math.min(score, 1),
      };
      await setCache(client, cacheKey, resolved, 60 * 60 * 24 * 30);
      return resolved;
    }
  }

  // Negative cache for a shorter window so we don't re-search every run —
  // but only when the search actually ran; a provider outage/quota error
  // must not be cached as "this company has no website".
  const miss: ResolvedDomain = { domain: null, source: "none", confidence: 0 };
  if (searchRan) {
    await setCache(client, cacheKey, miss, 60 * 60 * 24 * 3);
  }
  return miss;
}
