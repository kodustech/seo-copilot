// Semrush API integration — Authority Score + Backlinks DR50+/mo for the
// dashboard Growth KPIs. All functions return null when SEMRUSH_API_KEY is not
// set, so the dashboard falls back to placeholder cards instead of crashing.
//
// Docs: https://developer.semrush.com/api/v3/analytics/

const SEMRUSH_API_BASE = "https://api.semrush.com";
const TARGET_DOMAIN = process.env.SEMRUSH_TARGET_DOMAIN ?? "kodus.io";

function getApiKey(): string | null {
  const key = process.env.SEMRUSH_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

// Parse Semrush's CSV-with-semicolon-delimiter response into rows of the
// expected columns. First line is headers.
function parseSemrushCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(";");
  return lines.slice(1).map((line) => {
    const cells = line.split(";");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

export type SemrushDomainOverview = {
  authorityScore: number;
  organicTraffic: number;
  organicKeywords: number;
  backlinks: number;
  refDomains: number;
};

export async function getDomainOverview(
  domain: string = TARGET_DOMAIN,
): Promise<SemrushDomainOverview | null> {
  const key = getApiKey();
  if (!key) return null;

  // domain_ranks endpoint returns: Database, Date, Rank, Organic Keywords,
  // Organic Traffic, Organic Cost, Adwords Keywords, Adwords Traffic,
  // Adwords Cost. Authority Score comes from a separate `backlinks_overview`
  // endpoint.
  const params = new URLSearchParams({
    type: "domain_ranks",
    key,
    domain,
    database: "us",
    export_columns: "Db,Dt,Rk,Or,Ot,Oc,Ad,At,Ac",
  });

  try {
    const [ranksRes, backlinksRes] = await Promise.all([
      fetch(`${SEMRUSH_API_BASE}/?${params.toString()}`),
      fetch(
        `${SEMRUSH_API_BASE}/analytics/v1/?${new URLSearchParams({
          type: "backlinks_overview",
          key,
          target: domain,
          target_type: "root_domain",
          export_columns: "ascore,total,domains_num",
        }).toString()}`,
      ),
    ]);

    const [ranksText, backlinksText] = await Promise.all([
      ranksRes.text(),
      backlinksRes.text(),
    ]);

    const ranks = parseSemrushCsv(ranksText)[0] ?? {};
    const bl = parseSemrushCsv(backlinksText)[0] ?? {};

    return {
      authorityScore: Number(bl.ascore ?? 0),
      organicTraffic: Number(ranks.Ot ?? ranks["Organic Traffic"] ?? 0),
      organicKeywords: Number(ranks.Or ?? ranks["Organic Keywords"] ?? 0),
      backlinks: Number(bl.total ?? 0),
      refDomains: Number(bl.domains_num ?? 0),
    };
  } catch (error) {
    console.error("[semrush] domain overview error:", error);
    return null;
  }
}

export type SemrushNewBacklinks = {
  count: number;
  drMin: number;
  periodDays: number;
};

// Counts NEW backlinks discovered within the last N days with referring domain
// authority score >= drMin. Uses the backlinks_new analytics endpoint.
export async function getNewBacklinksAboveDr({
  domain = TARGET_DOMAIN,
  drMin = 50,
  periodDays = 30,
}: {
  domain?: string;
  drMin?: number;
  periodDays?: number;
} = {}): Promise<SemrushNewBacklinks | null> {
  const key = getApiKey();
  if (!key) return null;

  // Filter format: ascore_gt|<value> filters refdomain authority score > value
  const filter = `ascore_gt|${drMin - 1}`;

  const params = new URLSearchParams({
    type: "backlinks_new",
    key,
    target: domain,
    target_type: "root_domain",
    display_filter: filter,
    display_limit: "5000", // wide cap; we only return the count
    export_columns: "first_seen,source_url,source_title,target_url",
  });

  try {
    const res = await fetch(`${SEMRUSH_API_BASE}/analytics/v1/?${params.toString()}`);
    const text = await res.text();
    const rows = parseSemrushCsv(text);

    // Filter rows whose first_seen is within the period.
    const cutoff = new Date(Date.now() - periodDays * 86_400_000);
    const recent = rows.filter((r) => {
      const seen = r.first_seen ? new Date(r.first_seen) : null;
      return seen && seen >= cutoff;
    });

    return { count: recent.length, drMin, periodDays };
  } catch (error) {
    console.error("[semrush] new backlinks error:", error);
    return null;
  }
}
