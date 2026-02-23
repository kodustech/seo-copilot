"use client";

import { useCallback, useEffect, useState } from "react";
import { TrendingDown, TrendingUp, ArrowRight } from "lucide-react";
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
} from "@/lib/bigquery";
import type { BlogPost } from "@/lib/copilot";

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
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
          {data && (
            <p className="mt-1 text-xs text-neutral-500">
              {data.compare.periodLabel}
            </p>
          )}
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-28 border-white/10 bg-neutral-900 text-neutral-200">
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

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
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

      {/* Daily Trend Chart */}
      <Card className="border-white/10 bg-neutral-900">
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
      {!loading && data && (data.opportunities.strikingDistance.length > 0 || data.opportunities.lowCtr.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Striking Distance */}
          {data.opportunities.strikingDistance.length > 0 && (
            <Card className="border-amber-500/20 bg-neutral-900">
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
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/10">
                        <TableHead className="text-neutral-400">Query</TableHead>
                        <TableHead className="text-right text-neutral-400">Impressions</TableHead>
                        <TableHead className="text-right text-neutral-400">Position</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.opportunities.strikingDistance.slice(0, 8).map((r) => (
                        <TableRow key={`${r.query}-${r.page}`} className="border-white/5">
                          <TableCell className="max-w-[200px] truncate text-neutral-200" title={r.query}>
                            {r.query}
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
            <Card className="border-orange-500/20 bg-neutral-900">
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
                  High impressions but low clicks — improve titles and meta descriptions
                </p>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/10">
                        <TableHead className="text-neutral-400">Query</TableHead>
                        <TableHead className="text-right text-neutral-400">Impressions</TableHead>
                        <TableHead className="text-right text-neutral-400">CTR</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.opportunities.lowCtr.slice(0, 8).map((r) => (
                        <TableRow key={`${r.query}-${r.page}`} className="border-white/5">
                          <TableCell className="max-w-[200px] truncate text-neutral-200" title={r.query}>
                            {r.query}
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
        <Card className="border-red-500/20 bg-neutral-900">
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
            <div className="overflow-x-auto">
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

      {/* Tables side by side */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top Pages (GA4) */}
        <Card className="border-white/10 bg-neutral-900">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-neutral-300">
              Top Pages
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} cols={3} />
            ) : (
              <div className="overflow-x-auto">
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
        <Card className="border-white/10 bg-neutral-900">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-neutral-300">
              Top Queries
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} cols={4} />
            ) : (
              <div className="overflow-x-auto">
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

      {/* Traffic Sources */}
      <Card className="border-white/10 bg-neutral-900">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-neutral-300">
            Traffic Sources
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <TableSkeleton rows={5} cols={3} />
          ) : (
            <div className="overflow-x-auto">
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

function KpiCard({
  title,
  value,
  change,
  loading,
}: {
  title: string;
  value?: string;
  change?: number;
  loading: boolean;
}) {
  const isPositive = change !== undefined && change > 0;
  const isNegative = change !== undefined && change < 0;

  return (
    <Card className="border-white/10 bg-neutral-900">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-neutral-400">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-7 w-20 bg-neutral-800" />
        ) : (
          <div>
            <p className="text-2xl font-semibold text-white">{value}</p>
            {change !== undefined && (
              <div
                className={`mt-1 flex items-center gap-1 text-xs ${
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
          </div>
        )}
      </CardContent>
    </Card>
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
