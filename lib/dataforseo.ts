import { getSupabaseServiceClient } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN?.trim();
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD?.trim();
const BASE_URL = "https://api.dataforseo.com/v3/ai_optimization/llm_mentions";
const TARGET_DOMAIN = "kodus.io";

function getAuthHeader(): string {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set");
  }
  return `Basic ${Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString("base64")}`;
}

async function dfsPost<T>(endpoint: string, body: unknown[]): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DataForSEO ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
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
