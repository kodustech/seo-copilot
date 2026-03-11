import { getSupabaseServiceClient } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN?.trim();
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD?.trim();
const API_BASE = "https://api.dataforseo.com/v3";
const LLM_MENTIONS_BASE = `${API_BASE}/ai_optimization/llm_mentions`;
const TARGET_DOMAIN = "kodus.io";
const TARGET_KEYWORD = "kodus";

function getAuthHeader(): string {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set");
  }
  return `Basic ${Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString("base64")}`;
}

async function dfsPostRaw<T>(url: string, body: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DataForSEO ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

function dfsPost<T>(llmMentionsPath: string, body: unknown[]): Promise<T> {
  return dfsPostRaw<T>(`${LLM_MENTIONS_BASE}${llmMentionsPath}`, body);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Platform = "google" | "chat_gpt";

type DfsGroupElement = {
  type: string;
  key: string;
  mentions: number;
  ai_search_volume: number;
  impressions: number;
};

type DfsAggregatedResult = {
  total: {
    platform: DfsGroupElement[] | null;
    sources_domain: DfsGroupElement[] | null;
  };
};

type DfsSearchItem = {
  platform: string;
  question: string;
  answer: string;
  ai_search_volume: number;
  sources: { domain: string; url: string; title: string; position: number }[] | null;
};

type DfsResponse<T> = {
  tasks: {
    status_code: number;
    status_message: string;
    result: T[];
  }[];
};

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function fetchLLMAggregatedMetrics(
  platform: Platform,
): Promise<DfsAggregatedResult | null> {
  const data = await dfsPost<DfsResponse<DfsAggregatedResult>>(
    "/aggregated_metrics/live",
    [
      {
        target: [
          { domain: TARGET_DOMAIN, search_scope: ["any"], include_subdomains: true },
          { keyword: TARGET_KEYWORD, search_scope: ["answer", "brand_entities"], match_type: "partial_match" },
        ],
        platform,
        location_code: 2840,
        language_code: "en",
        internal_list_limit: 10,
      },
    ],
  );

  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  return task.result?.[0] ?? null;
}

export async function fetchLLMMentionsSearch(
  platform: Platform,
): Promise<DfsSearchItem[]> {
  const data = await dfsPost<
    DfsResponse<{ items: DfsSearchItem[] | null; total_count: number }>
  >("/search/live", [
    {
      target: [
        { domain: TARGET_DOMAIN, search_scope: ["sources"], include_subdomains: true },
        { keyword: TARGET_KEYWORD, search_scope: ["answer", "brand_entities"], match_type: "partial_match" },
      ],
      platform,
      location_code: 2840,
      language_code: "en",
      order_by: ["ai_search_volume,desc"],
      limit: 10,
    },
  ]);

  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return [];
  return task.result?.[0]?.items ?? [];
}

// ---------------------------------------------------------------------------
// Sync (called by cron)
// ---------------------------------------------------------------------------

export type LLMMentionsSnapshot = {
  snapshot_date: string;
  platform: Platform;
  mentions: number;
  ai_search_volume: number;
  impressions: number;
  top_sources: { domain: string; mentions: number; ai_search_volume: number }[];
  top_questions: { question: string; ai_search_volume: number }[];
};

export async function syncLLMMentionsSnapshot(): Promise<LLMMentionsSnapshot[]> {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    console.warn("[dataforseo] Skipping sync — credentials not configured");
    return [];
  }

  const today = new Date().toISOString().slice(0, 10);
  const platforms: Platform[] = ["google", "chat_gpt"];
  const snapshots: LLMMentionsSnapshot[] = [];

  const client = getSupabaseServiceClient();

  for (const platform of platforms) {
    try {
      const [aggregated, searchItems] = await Promise.all([
        fetchLLMAggregatedMetrics(platform),
        fetchLLMMentionsSearch(platform),
      ]);

      const platformMetrics = aggregated?.total?.platform?.[0];
      const topSourcesDfs = aggregated?.total?.sources_domain ?? [];

      const snapshot: LLMMentionsSnapshot = {
        snapshot_date: today,
        platform,
        mentions: platformMetrics?.mentions ?? 0,
        ai_search_volume: platformMetrics?.ai_search_volume ?? 0,
        impressions: platformMetrics?.impressions ?? 0,
        top_sources: topSourcesDfs.map((s) => ({
          domain: s.key,
          mentions: s.mentions,
          ai_search_volume: s.ai_search_volume,
        })),
        top_questions: searchItems.map((item) => ({
          question: item.question,
          ai_search_volume: item.ai_search_volume,
        })),
      };

      const { error } = await client.from("llm_mentions_snapshots").upsert(
        {
          snapshot_date: today,
          platform,
          mentions: snapshot.mentions,
          ai_search_volume: snapshot.ai_search_volume,
          impressions: snapshot.impressions,
          top_sources: snapshot.top_sources,
          top_questions: snapshot.top_questions,
          raw_response: { aggregated, searchItems },
        },
        { onConflict: "snapshot_date,platform" },
      );

      if (error) {
        console.error(`[dataforseo] Upsert error (${platform}):`, error.message);
      } else {
        snapshots.push(snapshot);
        console.log(`[dataforseo] Synced ${platform}: ${snapshot.mentions} mentions`);
      }
    } catch (err) {
      console.error(`[dataforseo] Sync error (${platform}):`, err);
    }
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// Read latest snapshots (for dashboard)
// ---------------------------------------------------------------------------

export async function getLatestLLMMentions(): Promise<LLMMentionsSnapshot[]> {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from("llm_mentions_snapshots")
    .select("snapshot_date, platform, mentions, ai_search_volume, impressions, top_sources, top_questions")
    .order("snapshot_date", { ascending: false })
    .limit(2);

  if (error) {
    console.error("[dataforseo] Read error:", error.message);
    return [];
  }

  return (data ?? []) as LLMMentionsSnapshot[];
}

// ---------------------------------------------------------------------------
// Keywords Data API (Google Ads Search Volume)
// ---------------------------------------------------------------------------

export type KeywordVolumeResult = {
  keyword: string;
  search_volume: number | null;
  competition: string | null;
  competition_index: number | null;
  cpc: number | null;
  monthly_searches: { year: number; month: number; search_volume: number }[] | null;
};

export async function fetchKeywordVolumes(
  keywords: string[],
  locationCode = 2840,
  languageCode = "en",
): Promise<KeywordVolumeResult[]> {
  if (!keywords.length) return [];
  // API limit: 1000 keywords per request
  const batch = keywords.slice(0, 1000);

  const data = await dfsPostRaw<
    DfsResponse<KeywordVolumeResult>
  >(`${API_BASE}/keywords_data/google_ads/search_volume/live`, [
    {
      keywords: batch,
      location_code: locationCode,
      language_code: languageCode,
    },
  ]);

  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return [];
  return task.result ?? [];
}

// ---------------------------------------------------------------------------
// SERP API (Google Organic Live)
// ---------------------------------------------------------------------------

export type SerpOrganicItem = {
  type: string;
  rank_group: number;
  rank_absolute: number;
  domain: string;
  title: string;
  description: string;
  url: string;
};

export type SerpResult = {
  keyword: string;
  se_results_count: number;
  items_count: number;
  items: SerpOrganicItem[];
};

export async function fetchSerpResults(
  keyword: string,
  locationCode = 2840,
  languageCode = "en",
  depth = 10,
): Promise<SerpResult | null> {
  const data = await dfsPostRaw<
    DfsResponse<{
      keyword: string;
      se_results_count: number;
      items_count: number;
      items: SerpOrganicItem[];
    }>
  >(`${API_BASE}/serp/google/organic/live/regular`, [
    {
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth: Math.min(depth, 100),
      device: "desktop",
    },
  ]);

  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  const result = task.result?.[0];
  if (!result) return null;

  return {
    keyword: result.keyword,
    se_results_count: result.se_results_count,
    items_count: result.items_count,
    items: (result.items ?? [])
      .filter((item) => item.type === "organic" || item.type === "featured_snippet")
      .map((item) => ({
        type: item.type,
        rank_group: item.rank_group,
        rank_absolute: item.rank_absolute,
        domain: item.domain,
        title: item.title,
        description: item.description,
        url: item.url,
      })),
  };
}
