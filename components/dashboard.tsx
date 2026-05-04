"use client";

import { useCallback, useEffect, useState } from "react";
import { TrendingDown, TrendingUp, ArrowRight, Bot, Sparkles } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

import type {
  TrafficOverviewResult,
  SearchPerformanceResult,
  TopContentResult,
  ComparePerformanceResult,
  ContentDecayResult,
  ContentOpportunitiesResult,
  ActivatedSignupsResult,
} from "@/lib/bigquery";
import type { BlogPost } from "@/lib/copilot";
import type { LLMMentionsSnapshot } from "@/lib/dataforseo";

type DashboardData = {
  period: string;
  startDate: string;
  endDate: string;
  traffic: TrafficOverviewResult;
  search: SearchPerformanceResult;
  topContent: TopContentResult;
  compare: ComparePerformanceResult;
  decay: ContentDecayResult;
  opportunities: ContentOpportunitiesResult;
  blogPosts: BlogPost[];
  llmMentions: LLMMentionsSnapshot[];
  activatedSignups: ActivatedSignupsResult | null;
};

function formatGaDate(raw: string): string {
  if (raw.length === 8) {
    return `${raw.slice(6, 8)}/${raw.slice(4, 6)}`;
  }
  return raw;
}

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatChangePercent(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatPosition(n: number): string {
  return n.toFixed(1);
}

// Section divider with a small uppercase label — Vercel/Linear style.
// Use sparingly to give the dashboard hierarchy without tabs.
function SectionHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-3 pb-1 pt-3 first:pt-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </h2>
      {hint && <p className="text-[11px] text-neutral-600">{hint}</p>}
      <div className="h-px flex-1 bg-white/[0.06]" />
    </div>
  );
}

// Strip protocol/host so the page column reads as a path. Falls back to the
// raw value if it's not a valid URL.
function shortenUrlPath(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const path = u.pathname || "/";
    // Add subdomain hint when it's not the main www host (helps distinguish
    // app.kodus.io vs kodus.io).
    const subdomain = u.hostname.split(".").slice(0, -2).join(".");
    return subdomain && subdomain !== "www" ? `${subdomain}:${path}` : path;
  } catch {
    return raw;
  }
}

export function Dashboard() {
  const [period, setPeriod] = useState("30d");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard?period=${p}`);
      if (!res.ok) throw new Error("Error while carregar dados.");
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(period);
  }, [period, fetchData]);

  const publishedPosts = data
    ? data.blogPosts.filter(
        (p) => p.publishedAt && p.publishedAt >= data.startDate,
      ).length
    : 0;

  const chartData = data
    ? data.traffic.dailyTrend.map((d) => ({
        date: formatGaDate(d.date),
        users: d.users,
      }))
    : [];

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-6 py-5 space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 pb-1">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Overview</h1>
          {data && (
            <p className="mt-0.5 text-[11px] text-neutral-500">
              {data.compare.periodLabel}
            </p>
          )}
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="h-8 w-24 border-white/[0.08] bg-neutral-900 text-xs text-neutral-200">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">7 dias</SelectItem>
            <SelectItem value="30d">30 dias</SelectItem>
            <SelectItem value="90d">90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {/* ── Growth KPIs (subset — Semrush AS + Backlinks DR50+ tracked
            manually elsewhere until API gating resolves) ───────────────────── */}
      <SectionHeader
        label="Growth KPIs"
        hint="From GROWTH_PLAN section 3 — Authority Score + Backlinks DR50+ tracked manually for now"
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard
          title="Activated signups"
          value={
            data?.activatedSignups
              ? formatNumber(data.activatedSignups.current.total)
              : undefined
          }
          change={
            data?.activatedSignups
              ? data.activatedSignups.change.total
              : undefined
          }
          loading={loading}
          hint={
            data?.activatedSignups
              ? `${data.activatedSignups.current.organizations} orgs · ${data.activatedSignups.current.users} personal`
              : "Orgs with Automated Code Review enabled"
          }
        />
        <KpiCard
          title="Top 10 commercial pages"
          value={
            data
              ? String(
                  data.search.topQueries.filter((q) => q.position <= 10).length,
                )
              : undefined
          }
          loading={loading}
          hint="Queries on page 1 (proxy)"
        />
        <KpiCard
          title="LLM citations"
          value={
            data
              ? String(
                  data.llmMentions.reduce((sum, s) => sum + s.mentions, 0),
                )
              : undefined
          }
          loading={loading}
          hint="Sum across Google AI + ChatGPT"
        />
      </div>

      {/* ── Traffic (secondary GA4 + Search Console metrics) ─────────────── */}
      <SectionHeader label="Traffic" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          title="Users"
          value={data ? formatNumber(data.traffic.overview.users) : undefined}
          change={data ? data.compare.traffic.change.users : undefined}
          loading={loading}
        />
        <KpiCard
          title="Sessions"
          value={data ? formatNumber(data.traffic.overview.sessions) : undefined}
          change={data ? data.compare.traffic.change.sessions : undefined}
          loading={loading}
        />
        <KpiCard
          title="Clicks (Search)"
          value={data ? formatNumber(data.search.totals.clicks) : undefined}
          change={data ? data.compare.search.change.clicks : undefined}
          loading={loading}
        />
        <KpiCard
          title="Average CTR"
          value={data ? formatPercent(data.search.totals.avgCtr) : undefined}
          change={data ? data.compare.search.change.avgCtr : undefined}
          loading={loading}
        />
        <KpiCard
          title="Published Posts"
          value={data ? String(publishedPosts) : undefined}
          loading={loading}
        />
      </div>

      {/* ── AI Visibility (LLM Mentions) ─────────────────────────────────── */}
      {!loading && data && data.llmMentions.length > 0 && (
        <>
          <SectionHeader label="AI Visibility" />
          <AIVisibilitySection snapshots={data.llmMentions} />
        </>
      )}

      {/* ── Daily Trend Chart ────────────────────────────────────────────── */}
      <SectionHeader label="Daily trend" />
      <Card className="border-white/[0.06] bg-neutral-900/50">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-neutral-300">
            Daily Visits (Users)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-64 w-full bg-neutral-800" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#a3a3a3", fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fill: "#a3a3a3", fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#171717",
                    border: "1px solid #333",
                    borderRadius: 8,
                    color: "#e5e5e5",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="users"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  dot={false}
                  name="Users"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Opportunities */}
      {!loading && data && (data.opportunities.strikingDistance.length > 0 || data.opportunities.lowCtr.length > 0 || data.decay.decaying.length > 0) && (
        <SectionHeader
          label="Action items"
          hint="Click to create a task on the Kanban"
        />
      )}
      {!loading && data && (data.opportunities.strikingDistance.length > 0 || data.opportunities.lowCtr.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Striking Distance */}
          {data.opportunities.strikingDistance.length > 0 && (
            <Card className="border-white/[0.06] bg-neutral-900/50">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm font-medium text-amber-400">
                    Striking Distance
                  </CardTitle>
                  <Badge variant="outline" className="border-amber-500/30 text-amber-400 text-[10px]">
                    Position 5-20
                  </Badge>
                </div>
                <p className="text-xs text-neutral-500">
                  Keywords close to page one — optimize to move up
                </p>
              </CardHeader>
              <CardContent>
                <div>
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/10">
                        <TableHead className="text-neutral-400">Query</TableHead>
                        <TableHead className="text-neutral-400">Page</TableHead>
                        <TableHead className="text-right text-neutral-400">Impressions</TableHead>
                        <TableHead className="text-right text-neutral-400">Position</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.opportunities.strikingDistance.slice(0, 8).map((r) => (
                        <TableRow key={`${r.query}-${r.page}`} className="border-white/5">
                          <TableCell className="max-w-[180px] truncate text-neutral-200" title={r.query}>
                            {r.query}
                          </TableCell>
                          <TableCell
                            className="max-w-[200px] truncate text-[11px] text-neutral-500"
                            title={r.page}
                          >
                            {shortenUrlPath(r.page)}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {formatNumber(r.impressions)}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {formatPosition(r.position)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Low CTR */}
          {data.opportunities.lowCtr.length > 0 && (
            <Card className="border-white/[0.06] bg-neutral-900/50">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm font-medium text-orange-400">
                    Low CTR
                  </CardTitle>
                  <Badge variant="outline" className="border-orange-500/30 text-orange-400 text-[10px]">
                    CTR &lt; 2%
                  </Badge>
                </div>
                <p className="text-xs text-neutral-500">
                  High impressions but low clicks — improve titles and meta descriptions.
                  Brand queries (kodus, kody) excluded — see P0.3 (block app.kodus.io).
                </p>
              </CardHeader>
              <CardContent>
                <div>
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/10">
                        <TableHead className="text-neutral-400">Query</TableHead>
                        <TableHead className="text-neutral-400">Page</TableHead>
                        <TableHead className="text-right text-neutral-400">Impressions</TableHead>
                        <TableHead className="text-right text-neutral-400">CTR</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.opportunities.lowCtr.slice(0, 8).map((r) => (
                        <TableRow key={`${r.query}-${r.page}`} className="border-white/5">
                          <TableCell className="max-w-[180px] truncate text-neutral-200" title={r.query}>
                            {r.query}
                          </TableCell>
                          <TableCell
                            className="max-w-[200px] truncate text-[11px] text-neutral-500"
                            title={r.page}
                          >
                            {shortenUrlPath(r.page)}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {formatNumber(r.impressions)}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {formatPercent(r.ctr)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Content Decay */}
      {!loading && data && data.decay.decaying.length > 0 && (
        <Card className="border-white/[0.06] bg-neutral-900/50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium text-red-400">
                Content Decay
              </CardTitle>
              <Badge variant="outline" className="border-red-500/30 text-red-400 text-[10px]">
                {data.decay.decaying.length} pages
              </Badge>
            </div>
            <p className="text-xs text-neutral-500">
              Pages losing traffic vs previous period ({data.decay.periodLabel})
            </p>
          </CardHeader>
          <CardContent>
            <div>
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10">
                    <TableHead className="text-neutral-400">Page</TableHead>
                    <TableHead className="text-right text-neutral-400">Before</TableHead>
                    <TableHead className="text-right text-neutral-400" />
                    <TableHead className="text-right text-neutral-400">Now</TableHead>
                    <TableHead className="text-right text-neutral-400">Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.decay.decaying.slice(0, 10).map((d) => (
                    <TableRow key={d.page} className="border-white/5">
                      <TableCell className="max-w-[260px] truncate text-neutral-200" title={d.page}>
                        {d.page}
                      </TableCell>
                      <TableCell className="text-right text-neutral-400">
                        {formatNumber(d.previousPageviews)}
                      </TableCell>
                      <TableCell className="text-center text-neutral-600">
                        <ArrowRight className="inline h-3 w-3" />
                      </TableCell>
                      <TableCell className="text-right text-neutral-300">
                        {formatNumber(d.currentPageviews)}
                      </TableCell>
                      <TableCell className="text-right font-medium text-red-400">
                        {formatChangePercent(d.changePercent)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Content performance ─────────────────────────────────────────── */}
      <SectionHeader label="Content performance" />
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Top Pages (GA4) */}
        <Card className="border-white/[0.06] bg-neutral-900/50">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-neutral-300">
              Top Pages
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} cols={3} />
            ) : (
              <div>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10">
                      <TableHead className="text-neutral-400">Page</TableHead>
                      <TableHead className="text-right text-neutral-400">Pageviews</TableHead>
                      <TableHead className="text-right text-neutral-400">Bounce Rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.topContent.pages.slice(0, 10).map((p) => (
                      <TableRow key={p.page} className="border-white/5">
                        <TableCell className="max-w-[240px] truncate text-neutral-200" title={p.page}>
                          {p.page}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatNumber(p.pageviews)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatPercent(p.bounceRate)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Queries (Search Console) */}
        <Card className="border-white/[0.06] bg-neutral-900/50">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-neutral-300">
              Top Queries
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} cols={4} />
            ) : (
              <div>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10">
                      <TableHead className="text-neutral-400">Query</TableHead>
                      <TableHead className="text-right text-neutral-400">Clicks</TableHead>
                      <TableHead className="text-right text-neutral-400">CTR</TableHead>
                      <TableHead className="text-right text-neutral-400">Position</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.search.topQueries.slice(0, 10).map((q) => (
                      <TableRow key={q.query} className="border-white/5">
                        <TableCell className="max-w-[200px] truncate text-neutral-200" title={q.query}>
                          {q.query}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatNumber(q.clicks)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatPercent(q.ctr)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatPosition(q.position)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Acquisition ─────────────────────────────────────────────────── */}
      <SectionHeader label="Acquisition" />
      <Card className="border-white/[0.06] bg-neutral-900/50">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-neutral-300">
            Traffic Sources
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <TableSkeleton rows={5} cols={3} />
          ) : (
            <div>
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10">
                    <TableHead className="text-neutral-400">Source</TableHead>
                    <TableHead className="text-neutral-400">Medium</TableHead>
                    <TableHead className="text-right text-neutral-400">Users</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.traffic.topSources.map((s) => (
                    <TableRow key={`${s.source}-${s.medium}`} className="border-white/5">
                      <TableCell className="text-neutral-200">{s.source}</TableCell>
                      <TableCell className="text-neutral-300">{s.medium}</TableCell>
                      <TableCell className="text-right text-neutral-300">
                        {formatNumber(s.users)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function AIVisibilitySection({ snapshots }: { snapshots: LLMMentionsSnapshot[] }) {
  const google = snapshots.find((s) => s.platform === "google");
  const chatgpt = snapshots.find((s) => s.platform === "chat_gpt");

  const allQuestions = [
    ...(google?.top_questions ?? []),
    ...(chatgpt?.top_questions ?? []),
  ].sort((a, b) => b.ai_search_volume - a.ai_search_volume);

  const allSources = [
    ...(google?.top_sources ?? []),
    ...(chatgpt?.top_sources ?? []),
  ];

  // Deduplicate and sum sources by domain
  const sourceMap = new Map<string, { domain: string; mentions: number; ai_search_volume: number }>();
  for (const s of allSources) {
    const existing = sourceMap.get(s.domain);
    if (existing) {
      existing.mentions += s.mentions;
      existing.ai_search_volume += s.ai_search_volume;
    } else {
      sourceMap.set(s.domain, { ...s });
    }
  }
  const topSources = [...sourceMap.values()]
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 8);

  const snapshotDate = google?.snapshot_date ?? chatgpt?.snapshot_date;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-400" />
        <h2 className="text-sm font-semibold text-white">AI Visibility</h2>
        {snapshotDate && (
          <span className="text-[10px] text-neutral-600">
            Last sync: {snapshotDate}
          </span>
        )}
      </div>

      {/* AI KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <AiKpiCard
          title="Google AI Mentions"
          value={google?.mentions ?? 0}
          icon={<Bot className="h-3.5 w-3.5 text-blue-400" />}
        />
        <AiKpiCard
          title="ChatGPT Mentions"
          value={chatgpt?.mentions ?? 0}
          icon={<Bot className="h-3.5 w-3.5 text-emerald-400" />}
        />
        <AiKpiCard
          title="AI Search Volume"
          value={(google?.ai_search_volume ?? 0) + (chatgpt?.ai_search_volume ?? 0)}
          icon={<Sparkles className="h-3.5 w-3.5 text-violet-400" />}
          compact
        />
      </div>

      {/* Tables */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top AI Questions */}
        {allQuestions.length > 0 && (
          <Card className="border-white/[0.06] bg-neutral-900/50">
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-medium text-violet-400">
                  Top AI Questions
                </CardTitle>
                <Badge variant="outline" className="border-violet-500/30 text-violet-400 text-[10px]">
                  {allQuestions.length} queries
                </Badge>
              </div>
              <p className="text-xs text-neutral-500">
                Questions where kodus.io appears in LLM responses
              </p>
            </CardHeader>
            <CardContent>
              <div>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10">
                      <TableHead className="text-neutral-400">Question</TableHead>
                      <TableHead className="text-right text-neutral-400">AI Volume</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allQuestions.slice(0, 10).map((q, i) => (
                      <TableRow key={`${q.question}-${i}`} className="border-white/5">
                        <TableCell className="max-w-[300px] truncate text-neutral-200" title={q.question}>
                          {q.question}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatCompact(q.ai_search_volume)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Top Co-Mentioned Sources */}
        {topSources.length > 0 && (
          <Card className="border-white/[0.06] bg-neutral-900/50">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-neutral-300">
                Co-Mentioned Sources
              </CardTitle>
              <p className="text-xs text-neutral-500">
                Domains cited alongside kodus.io in AI responses
              </p>
            </CardHeader>
            <CardContent>
              <div>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10">
                      <TableHead className="text-neutral-400">Domain</TableHead>
                      <TableHead className="text-right text-neutral-400">Mentions</TableHead>
                      <TableHead className="text-right text-neutral-400">AI Volume</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topSources.map((s) => (
                      <TableRow key={s.domain} className="border-white/5">
                        <TableCell className="text-neutral-200">{s.domain}</TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatNumber(s.mentions)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatCompact(s.ai_search_volume)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function AiKpiCard({
  title,
  value,
  icon,
  compact,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <Card className="border-white/[0.06] bg-neutral-900/50">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5">
          {icon}
          <CardTitle className="text-xs font-medium text-neutral-400">
            {title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold text-white">
          {compact ? formatCompact(value) : formatNumber(value)}
        </p>
      </CardContent>
    </Card>
  );
}

function KpiCard({
  title,
  value,
  change,
  loading,
  placeholder,
  hint,
}: {
  title: string;
  value?: string;
  change?: number;
  loading?: boolean;
  // When the metric isn't computed yet, show this in muted style.
  placeholder?: string;
  hint?: string;
}) {
  const isPositive = change !== undefined && change > 0;
  const isNegative = change !== undefined && change < 0;
  const showPlaceholder = !loading && !value && !!placeholder;

  return (
    <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        {title}
      </p>
      <div className="mt-1.5">
        {loading ? (
          <Skeleton className="h-7 w-20 bg-neutral-800" />
        ) : showPlaceholder ? (
          <div>
            <p className="text-xl font-semibold tracking-tight text-neutral-600">
              {placeholder}
            </p>
            {hint && (
              <p className="mt-1 text-[10px] text-neutral-600">{hint}</p>
            )}
          </div>
        ) : (
          <div>
            <p className="text-xl font-semibold tracking-tight text-white">{value}</p>
            {change !== undefined && (
              <div
                className={`mt-1 flex items-center gap-1 text-[11px] ${
                  isPositive
                    ? "text-emerald-400"
                    : isNegative
                      ? "text-red-400"
                      : "text-neutral-500"
                }`}
              >
                {isPositive && <TrendingUp className="h-3 w-3" />}
                {isNegative && <TrendingDown className="h-3 w-3" />}
                <span>{formatChangePercent(change)}</span>
                <span className="text-neutral-600">vs previous</span>
              </div>
            )}
            {!change && hint && (
              <p className="mt-1 text-[10px] text-neutral-600">{hint}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TableSkeleton({ rows, cols }: { rows: number; cols: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className="h-4 flex-1 bg-neutral-800" />
          ))}
        </div>
      ))}
    </div>
  );
}
