import { BigQuery } from "@google-cloud/bigquery";

// ---------------------------------------------------------------------------
// Client (lazy singleton)
// ---------------------------------------------------------------------------

let _client: BigQuery | null = null;

function getClient(): BigQuery {
  if (_client) return _client;

  const raw = process.env.BIGQUERY_CREDENTIALS;
  if (!raw) {
    throw new Error(
      "BIGQUERY_CREDENTIALS env var is not set. Provide the service-account JSON string.",
    );
  }

  const credentials = JSON.parse(raw) as {
    client_email: string;
    private_key: string;
    project_id?: string;
  };

  _client = new BigQuery({
    projectId: credentials.project_id ?? "kody-408918",
    credentials,
  });

  return _client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDateRange(
  startDate?: string,
  endDate?: string,
  defaultDays = 28,
): { start: string; end: string } {
  const end = endDate ?? new Date().toISOString().slice(0, 10);
  const start =
    startDate ??
    new Date(Date.now() - defaultDays * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

async function runQuery<T>(
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const client = getClient();
  const [rows] = await client.query({ query: sql, params });
  return rows as T[];
}

// ---------------------------------------------------------------------------
// 1. Search Performance (Google Search Console)
// ---------------------------------------------------------------------------

export type SearchPerformanceResult = {
  totals: {
    clicks: number;
    impressions: number;
    avgCtr: number;
    avgPosition: number;
  };
  topQueries: {
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
  topPages: {
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
};

export async function querySearchPerformance({
  startDate,
  endDate,
  limit = 20,
}: {
  startDate?: string;
  endDate?: string;
  limit?: number;
} = {}): Promise<SearchPerformanceResult> {
  const { start, end } = resolveDateRange(startDate, endDate);

  const [totalsRows, queryRows, pageRows] = await Promise.all([
    runQuery<{
      clicks: number;
      impressions: number;
      avg_ctr: number;
      avg_position: number;
    }>(
      `SELECT
         SUM(clicks) AS clicks,
         SUM(impressions) AS impressions,
         SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS avg_ctr,
         AVG(position) AS avg_position
       FROM \`kody-408918.kodus_search_console.search_analytics_by_query\`
       WHERE date BETWEEN @start AND @end`,
      { start, end },
    ),
    runQuery<{
      query: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>(
      `SELECT
         query,
         SUM(clicks) AS clicks,
         SUM(impressions) AS impressions,
         SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
         AVG(position) AS position
       FROM \`kody-408918.kodus_search_console.search_analytics_by_query\`
       WHERE date BETWEEN @start AND @end
       GROUP BY query
       ORDER BY clicks DESC
       LIMIT @limit`,
      { start, end, limit },
    ),
    runQuery<{
      page: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>(
      `SELECT
         page,
         SUM(clicks) AS clicks,
         SUM(impressions) AS impressions,
         SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
         AVG(position) AS position
       FROM \`kody-408918.kodus_search_console.search_analytics_by_page\`
       WHERE date BETWEEN @start AND @end
       GROUP BY page
       ORDER BY clicks DESC
       LIMIT @limit`,
      { start, end, limit },
    ),
  ]);

  const t = totalsRows[0] ?? {
    clicks: 0,
    impressions: 0,
    avg_ctr: 0,
    avg_position: 0,
  };

  return {
    totals: {
      clicks: Number(t.clicks),
      impressions: Number(t.impressions),
      avgCtr: Number(t.avg_ctr),
      avgPosition: Number(t.avg_position),
    },
    topQueries: queryRows.map((r) => ({
      query: r.query,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      ctr: Number(r.ctr),
      position: Number(r.position),
    })),
    topPages: pageRows.map((r) => ({
      page: r.page,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      ctr: Number(r.ctr),
      position: Number(r.position),
    })),
  };
}

// ---------------------------------------------------------------------------
// 2. Traffic Overview (GA4)
// ---------------------------------------------------------------------------

export type TrafficOverviewResult = {
  overview: {
    users: number;
    sessions: number;
    pageviews: number;
  };
  topSources: {
    source: string;
    medium: string;
    users: number;
  }[];
  dailyTrend: {
    date: string;
    users: number;
  }[];
};

export async function queryTrafficOverview({
  startDate,
  endDate,
  limit = 10,
}: {
  startDate?: string;
  endDate?: string;
  limit?: number;
} = {}): Promise<TrafficOverviewResult> {
  const { start, end } = resolveDateRange(startDate, endDate);

  const [overviewRows, sourceRows, dailyRows] = await Promise.all([
    runQuery<{ users: number; sessions: number; pageviews: number }>(
      `SELECT
         SUM(totalUsers) AS users,
         SUM(sessions) AS sessions,
         SUM(screenPageViews) AS pageviews
       FROM \`kody-408918.kodus_ga.website_overview\`
       WHERE date BETWEEN REPLACE(@start, '-', '') AND REPLACE(@end, '-', '')`,
      { start, end },
    ),
    runQuery<{ source: string; medium: string; users: number }>(
      `SELECT
         sessionSource AS source,
         sessionMedium AS medium,
         SUM(totalUsers) AS users
       FROM \`kody-408918.kodus_ga.traffic_sources\`
       WHERE date BETWEEN REPLACE(@start, '-', '') AND REPLACE(@end, '-', '')
       GROUP BY sessionSource, sessionMedium
       ORDER BY users DESC
       LIMIT @limit`,
      { start, end, limit },
    ),
    runQuery<{ date: string; users: number }>(
      `SELECT
         date,
         SUM(active1DayUsers) AS users
       FROM \`kody-408918.kodus_ga.daily_active_users\`
       WHERE date BETWEEN REPLACE(@start, '-', '') AND REPLACE(@end, '-', '')
       GROUP BY date
       ORDER BY date ASC`,
      { start, end },
    ),
  ]);

  const o = overviewRows[0] ?? { users: 0, sessions: 0, pageviews: 0 };

  return {
    overview: {
      users: Number(o.users),
      sessions: Number(o.sessions),
      pageviews: Number(o.pageviews),
    },
    topSources: sourceRows.map((r) => ({
      source: r.source,
      medium: r.medium,
      users: Number(r.users),
    })),
    dailyTrend: dailyRows.map((r) => ({
      date: r.date,
      users: Number(r.users),
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. Top Content (GA4)
// ---------------------------------------------------------------------------

export type TopContentResult = {
  pages: {
    page: string;
    pageviews: number;
    bounceRate: number;
  }[];
};

export async function queryTopContent({
  startDate,
  endDate,
  limit = 20,
  pathFilter,
}: {
  startDate?: string;
  endDate?: string;
  limit?: number;
  pathFilter?: string;
} = {}): Promise<TopContentResult> {
  const { start, end } = resolveDateRange(startDate, endDate);

  const filterClause = pathFilter
    ? `AND pagePathPlusQueryString LIKE @pathFilter`
    : "";
  const params: Record<string, unknown> = { start, end, limit };
  if (pathFilter) params.pathFilter = `${pathFilter}%`;

  const rows = await runQuery<{
    page: string;
    pageviews: number;
    bounce_rate: number;
  }>(
    `SELECT
       pagePathPlusQueryString AS page,
       SUM(screenPageViews) AS pageviews,
       AVG(bounceRate) AS bounce_rate
     FROM \`kody-408918.kodus_ga.pages\`
     WHERE date BETWEEN REPLACE(@start, '-', '') AND REPLACE(@end, '-', '') ${filterClause}
     GROUP BY pagePathPlusQueryString
     ORDER BY pageviews DESC
     LIMIT @limit`,
    params,
  );

  return {
    pages: rows.map((r) => ({
      page: r.page,
      pageviews: Number(r.pageviews),
      bounceRate: Number(r.bounce_rate),
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. Content Opportunities (Search Console)
// ---------------------------------------------------------------------------

export type ContentOpportunitiesResult = {
  lowCtr: {
    query: string;
    page: string;
    impressions: number;
    ctr: number;
    position: number;
  }[];
  strikingDistance: {
    query: string;
    page: string;
    impressions: number;
    ctr: number;
    position: number;
  }[];
};

export async function queryContentOpportunities({
  startDate,
  endDate,
  limit = 20,
}: {
  startDate?: string;
  endDate?: string;
  limit?: number;
} = {}): Promise<ContentOpportunitiesResult> {
  const { start, end } = resolveDateRange(startDate, endDate);

  const [lowCtrRows, strikingRows] = await Promise.all([
    runQuery<{
      query: string;
      page: string;
      impressions: number;
      ctr: number;
      position: number;
    }>(
      `SELECT
         query,
         page,
         SUM(impressions) AS impressions,
         SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
         AVG(position) AS position
       FROM \`kody-408918.kodus_search_console.search_analytics_all_fields\`
       WHERE date BETWEEN @start AND @end
       GROUP BY query, page
       HAVING impressions > 100 AND ctr < 0.02
       ORDER BY impressions DESC
       LIMIT @limit`,
      { start, end, limit },
    ),
    runQuery<{
      query: string;
      page: string;
      impressions: number;
      ctr: number;
      position: number;
    }>(
      `SELECT
         query,
         page,
         SUM(impressions) AS impressions,
         SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
         AVG(position) AS position
       FROM \`kody-408918.kodus_search_console.search_analytics_all_fields\`
       WHERE date BETWEEN @start AND @end
       GROUP BY query, page
       HAVING position BETWEEN 5 AND 20
       ORDER BY impressions DESC
       LIMIT @limit`,
      { start, end, limit },
    ),
  ]);

  return {
    lowCtr: lowCtrRows.map((r) => ({
      query: r.query,
      page: r.page,
      impressions: Number(r.impressions),
      ctr: Number(r.ctr),
      position: Number(r.position),
    })),
    strikingDistance: strikingRows.map((r) => ({
      query: r.query,
      page: r.page,
      impressions: Number(r.impressions),
      ctr: Number(r.ctr),
      position: Number(r.position),
    })),
  };
}

// ---------------------------------------------------------------------------
// 5. Compare Performance (Search Console + GA4)
// ---------------------------------------------------------------------------

type PeriodMetrics = {
  clicks: number;
  impressions: number;
  avgCtr: number;
  avgPosition: number;
};

type TrafficPeriodMetrics = {
  users: number;
  sessions: number;
  pageviews: number;
};

function computeChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function computePreviousPeriod(start: string, end: string): { start: string; end: string } {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const durationMs = endMs - startMs;
  const prevEnd = new Date(startMs - 86_400_000); // day before current start
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10),
  };
}

export type ComparePerformanceResult = {
  search: {
    current: PeriodMetrics;
    previous: PeriodMetrics;
    change: { clicks: number; impressions: number; avgCtr: number; avgPosition: number };
  };
  traffic: {
    current: TrafficPeriodMetrics;
    previous: TrafficPeriodMetrics;
    change: { users: number; sessions: number; pageviews: number };
  };
  periodLabel: string;
};

export async function queryComparePerformance({
  startDate,
  endDate,
}: {
  startDate?: string;
  endDate?: string;
} = {}): Promise<ComparePerformanceResult> {
  const current = resolveDateRange(startDate, endDate);
  const previous = computePreviousPeriod(current.start, current.end);

  const searchSql = `
    SELECT
      SUM(clicks) AS clicks,
      SUM(impressions) AS impressions,
      SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS avg_ctr,
      AVG(position) AS avg_position
    FROM \`kody-408918.kodus_search_console.search_analytics_by_query\`
    WHERE date BETWEEN @start AND @end`;

  const trafficSql = `
    SELECT
      SUM(totalUsers) AS users,
      SUM(sessions) AS sessions,
      SUM(screenPageViews) AS pageviews
    FROM \`kody-408918.kodus_ga.website_overview\`
    WHERE date BETWEEN REPLACE(@start, '-', '') AND REPLACE(@end, '-', '')`;

  const [curSearch, prevSearch, curTraffic, prevTraffic] = await Promise.all([
    runQuery<{ clicks: number; impressions: number; avg_ctr: number; avg_position: number }>(
      searchSql, { start: current.start, end: current.end },
    ),
    runQuery<{ clicks: number; impressions: number; avg_ctr: number; avg_position: number }>(
      searchSql, { start: previous.start, end: previous.end },
    ),
    runQuery<{ users: number; sessions: number; pageviews: number }>(
      trafficSql, { start: current.start, end: current.end },
    ),
    runQuery<{ users: number; sessions: number; pageviews: number }>(
      trafficSql, { start: previous.start, end: previous.end },
    ),
  ]);

  const cs = curSearch[0] ?? { clicks: 0, impressions: 0, avg_ctr: 0, avg_position: 0 };
  const ps = prevSearch[0] ?? { clicks: 0, impressions: 0, avg_ctr: 0, avg_position: 0 };
  const ct = curTraffic[0] ?? { users: 0, sessions: 0, pageviews: 0 };
  const pt = prevTraffic[0] ?? { users: 0, sessions: 0, pageviews: 0 };

  const curSearchMetrics: PeriodMetrics = {
    clicks: Number(cs.clicks),
    impressions: Number(cs.impressions),
    avgCtr: Number(cs.avg_ctr),
    avgPosition: Number(cs.avg_position),
  };
  const prevSearchMetrics: PeriodMetrics = {
    clicks: Number(ps.clicks),
    impressions: Number(ps.impressions),
    avgCtr: Number(ps.avg_ctr),
    avgPosition: Number(ps.avg_position),
  };
  const curTrafficMetrics: TrafficPeriodMetrics = {
    users: Number(ct.users),
    sessions: Number(ct.sessions),
    pageviews: Number(ct.pageviews),
  };
  const prevTrafficMetrics: TrafficPeriodMetrics = {
    users: Number(pt.users),
    sessions: Number(pt.sessions),
    pageviews: Number(pt.pageviews),
  };

  const fmt = (d: string) => {
    const [y, m, day] = d.split("-");
    return `${day}/${m}`;
  };

  return {
    search: {
      current: curSearchMetrics,
      previous: prevSearchMetrics,
      change: {
        clicks: computeChange(curSearchMetrics.clicks, prevSearchMetrics.clicks),
        impressions: computeChange(curSearchMetrics.impressions, prevSearchMetrics.impressions),
        avgCtr: computeChange(curSearchMetrics.avgCtr, prevSearchMetrics.avgCtr),
        avgPosition: computeChange(curSearchMetrics.avgPosition, prevSearchMetrics.avgPosition),
      },
    },
    traffic: {
      current: curTrafficMetrics,
      previous: prevTrafficMetrics,
      change: {
        users: computeChange(curTrafficMetrics.users, prevTrafficMetrics.users),
        sessions: computeChange(curTrafficMetrics.sessions, prevTrafficMetrics.sessions),
        pageviews: computeChange(curTrafficMetrics.pageviews, prevTrafficMetrics.pageviews),
      },
    },
    periodLabel: `${fmt(current.start)} - ${fmt(current.end)} vs ${fmt(previous.start)} - ${fmt(previous.end)}`,
  };
}

// ---------------------------------------------------------------------------
// 6. Content Decay (GA4 pages)
// ---------------------------------------------------------------------------

export type ContentDecayResult = {
  decaying: {
    page: string;
    currentPageviews: number;
    previousPageviews: number;
    changePercent: number;
  }[];
  periodLabel: string;
};

export async function queryContentDecay({
  startDate,
  endDate,
  limit = 30,
  minPageviews = 10,
}: {
  startDate?: string;
  endDate?: string;
  limit?: number;
  minPageviews?: number;
} = {}): Promise<ContentDecayResult> {
  const current = resolveDateRange(startDate, endDate);
  const previous = computePreviousPeriod(current.start, current.end);

  const sql = `
    SELECT
      pagePathPlusQueryString AS page,
      SUM(screenPageViews) AS pageviews
    FROM \`kody-408918.kodus_ga.pages\`
    WHERE date BETWEEN REPLACE(@start, '-', '') AND REPLACE(@end, '-', '')
    GROUP BY pagePathPlusQueryString`;

  const [curRows, prevRows] = await Promise.all([
    runQuery<{ page: string; pageviews: number }>(sql, { start: current.start, end: current.end }),
    runQuery<{ page: string; pageviews: number }>(sql, { start: previous.start, end: previous.end }),
  ]);

  const prevMap = new Map(prevRows.map((r) => [r.page, Number(r.pageviews)]));
  const curMap = new Map(curRows.map((r) => [r.page, Number(r.pageviews)]));

  const decaying: ContentDecayResult["decaying"] = [];

  for (const [page, prevPv] of prevMap) {
    if (prevPv < minPageviews) continue;
    const curPv = curMap.get(page) ?? 0;
    if (curPv >= prevPv) continue;
    decaying.push({
      page,
      currentPageviews: curPv,
      previousPageviews: prevPv,
      changePercent: ((curPv - prevPv) / prevPv) * 100,
    });
  }

  decaying.sort((a, b) => (a.currentPageviews - a.previousPageviews) - (b.currentPageviews - b.previousPageviews));

  const fmt = (d: string) => {
    const [, m, day] = d.split("-");
    return `${day}/${m}`;
  };

  return {
    decaying: decaying.slice(0, limit),
    periodLabel: `${fmt(current.start)} - ${fmt(current.end)} vs ${fmt(previous.start)} - ${fmt(previous.end)}`,
  };
}

// ---------------------------------------------------------------------------
// 7. Search by Segment (Search Console)
// ---------------------------------------------------------------------------

export type SearchBySegmentResult = {
  segments: {
    segment: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
};

export async function querySearchBySegment({
  startDate,
  endDate,
  segment,
  limit = 20,
}: {
  startDate?: string;
  endDate?: string;
  segment: "device" | "country";
  limit?: number;
}): Promise<SearchBySegmentResult> {
  const { start, end } = resolveDateRange(startDate, endDate);

  const rows = await runQuery<{
    segment: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>(
    `SELECT
       ${segment} AS segment,
       SUM(clicks) AS clicks,
       SUM(impressions) AS impressions,
       SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
       AVG(position) AS position
     FROM \`kody-408918.kodus_search_console.search_analytics_all_fields\`
     WHERE date BETWEEN @start AND @end
     GROUP BY ${segment}
     ORDER BY clicks DESC
     LIMIT @limit`,
    { start, end, limit },
  );

  return {
    segments: rows.map((r) => ({
      segment: r.segment,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      ctr: Number(r.ctr),
      position: Number(r.position),
    })),
  };
}
