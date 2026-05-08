// Open PageRank (domcop.com) — free domain authority alternative.
// Free tier: 1000 requests/day, up to 100 domains per request.
// Get a key at https://www.domcop.com/openpagerank/auth/signup and set
// OPENPAGERANK_API_KEY. Without a key all functions return null and callers
// treat that as "unknown" (not zero), so the UI degrades gracefully.
//
// Score: 0–10 (logarithmic-ish, like classic Google PageRank). Most legit
// dev blogs land between 3 and 6; obvious scams hover at 0–1.

const OPR_BASE = "https://openpagerank.com/api/v1.0/getPageRank";
const MAX_DOMAINS_PER_CALL = 100;

function getApiKey(): string | null {
  const key = process.env.OPENPAGERANK_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

type OprDomainResponse = {
  status_code: number;
  error: string;
  page_rank_integer: number;
  page_rank_decimal: number;
  rank: string;
  domain: string;
};

type OprResponse = {
  status_code: number;
  response?: OprDomainResponse[];
  last_updated?: string;
};

function normalize(domain: string): string | null {
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];
  if (!cleaned || !cleaned.includes(".")) return null;
  return cleaned;
}

// Batch lookup. Returns a map domain → score (0–10) or null per domain.
// Unknown domains and API failures map to null.
export async function getOpenPageRank(
  domains: string[],
): Promise<Record<string, number | null>> {
  const key = getApiKey();
  const normalized = Array.from(
    new Set(
      domains
        .map(normalize)
        .filter((d): d is string => d !== null),
    ),
  );
  const result: Record<string, number | null> = {};
  for (const d of normalized) result[d] = null;
  if (!key || normalized.length === 0) return result;

  for (let i = 0; i < normalized.length; i += MAX_DOMAINS_PER_CALL) {
    const batch = normalized.slice(i, i + MAX_DOMAINS_PER_CALL);
    const qs = batch.map((d) => `domains[]=${encodeURIComponent(d)}`).join("&");
    try {
      const res = await fetch(`${OPR_BASE}?${qs}`, {
        headers: { "API-OPR": key },
      });
      if (!res.ok) {
        console.error(
          `[open-pagerank] HTTP ${res.status} ${res.statusText} for batch of ${batch.length}`,
        );
        continue;
      }
      const data = (await res.json()) as OprResponse;
      for (const row of data.response ?? []) {
        if (row.status_code === 200 && Number.isFinite(row.page_rank_decimal)) {
          result[row.domain] = row.page_rank_decimal;
        }
      }
    } catch (error) {
      console.error("[open-pagerank] fetch failed:", error);
    }
  }

  return result;
}
