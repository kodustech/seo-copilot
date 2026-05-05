"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TrendingDown,
  TrendingUp,
  ArrowRight,
  Bot,
  Sparkles,
  Plus,
  Check,
  Clipboard,
  ClipboardCheck,
  MoreHorizontal,
} from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
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
  CannibalizationResult,
  InternalLinkGapResult,
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
  cannibalization: CannibalizationResult;
  internalLinkGaps: InternalLinkGapResult;
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

// Auth token hook — reused across components that need to call authenticated
// endpoints (the kanban API requires a Supabase JWT).
function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
      setEmail(data.session?.user?.email ?? null);
    });
  }, [supabase]);

  return { token, email };
}

type CreateCardInput = {
  title: string;
  description: string;
  itemType?: "task" | "update";
  priority?: "low" | "medium" | "high";
  link?: string;
};

// Hook that posts a card to the kanban and tracks success per row key so the
// UI can flip the button to a "Created" check state. Uses the user JWT via the
// /api/kanban/items endpoint (service-role MCP path is server-only).
function useCardCreator() {
  const { token, email } = useAuthToken();
  const [actioned, setActioned] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());

  async function createCard(rowKey: string, input: CreateCardInput) {
    if (!token || pending.has(rowKey) || actioned.has(rowKey)) return;
    setPending((s) => new Set(s).add(rowKey));
    try {
      const res = await fetch("/api/kanban/items", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          itemType: input.itemType ?? "update",
          priority: input.priority ?? "medium",
          link: input.link,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setActioned((s) => new Set(s).add(rowKey));
    } catch (err) {
      console.error("[dashboard] createCard error:", err);
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(rowKey);
        return next;
      });
    }
  }

  return { createCard, actioned, pending, ready: !!token, email };
}

// Per-section "Now produce" instructions used by the Copy-LLM button. Kept
// here (not in lib/) because they are tightly coupled to which dashboard rows
// surface a given action.
type LlmTaskKind =
  | "striking"
  | "lowctr"
  | "decay"
  | "cannibalization"
  | "linkgap";

const LLM_TASK_LABELS: Record<LlmTaskKind, string> = {
  striking: "Striking distance keyword",
  lowctr: "Low CTR query",
  decay: "Decaying page",
  cannibalization: "Keyword cannibalization",
  linkgap: "Internal link gap",
};

const LLM_TASKS: Record<LlmTaskKind, string> = {
  striking:
    `Produce a recovery plan to push this page from page 2 into the top 10:\n\n` +
    `1. **3 title options** (≤60 chars) — each variant tests a different angle (informational / comparative / commercial)\n` +
    `2. **One H1** aligned with the query intent\n` +
    `3. **5 internal-link sources** — list 5 existing kodus.io pages that should link here, with the suggested anchor text and a 1-sentence paragraph context for each\n` +
    `4. **3 on-page improvements** — sections to add, reorder, or rewrite\n` +
    `5. **Schema recommendations** — pick the 1-2 schema types that best fit (FAQPage, HowTo, Article, Product, etc.) and emit sample JSON-LD`,
  lowctr:
    `Rewrite the SEO surface to lift CTR. Produce:\n\n` +
    `1. **3 title variants** (≤60 chars) — test angle, urgency, specificity\n` +
    `2. **3 meta-description variants** (≤155 chars)\n` +
    `3. **5 FAQ Q&As** suitable for FAQPage schema, with answers (50-80 words each)\n` +
    `4. **One opening paragraph** (≤80 words) that should appear right after the H1 to confirm intent fit\n` +
    `5. **Brand-vs-generic check** — flag if the query is informational vs commercial and recommend whether to keep or restructure the page`,
  decay:
    `Recommend a recovery action for this decaying page. Produce:\n\n` +
    `1. **Decision**: rewrite / 301 / 410 — and a 2-3 sentence rationale\n` +
    `2. **If rewrite**: outline the new structure (H1 + 5-7 sections), what to keep, what to drop, and why\n` +
    `3. **If 301**: suggest the best target page on kodus.io with rationale\n` +
    `4. **3 internal-link sources** that should point to whatever the recovered page becomes\n` +
    `5. **Risk callout** — what could go wrong (loss of long-tail rankings, etc.) and how to mitigate`,
  cannibalization:
    `Resolve cannibalization between competing pages. Produce:\n\n` +
    `1. **Canonical pick**: which page to keep, with rationale comparing engagement, position, and intent fit\n` +
    `2. **301 plan**: which other pages should redirect, target slugs, and order of execution\n` +
    `3. **Internal-link sweep**: 5 inbound link sources to lift the canonical (anchor + paragraph context)\n` +
    `4. **On-page tweaks** for the canonical so it owns this query (title, H1, intro paragraph)\n` +
    `5. **Validation step** — what to check in GSC after 14d to confirm the fix worked`,
  linkgap:
    `Lift this page via internal links. Produce:\n\n` +
    `1. **5 inbound internal-link sources** from existing kodus.io pages — for each:\n` +
    `   - Source URL\n` +
    `   - Suggested anchor text (≤6 words)\n` +
    `   - Paragraph context (1-2 sentences) showing where the link naturally fits\n` +
    `2. **2 structurally-valuable links** from microsites or external assets (aicodereviews.io, codereviewbench.com, awesome-ai-code-review)\n` +
    `3. **One on-page tweak** that signals topical authority on the target query\n` +
    `4. **Anchor-text diversity check** — confirm the 5 anchors don't all repeat the same phrase`,
};

const LLM_BRAND_PREAMBLE =
  `# Context\n\n` +
  `You are assisting the growth team at **Kodus** (open-source AI code review for engineering teams, https://kodus.io).\n\n` +
  `**Brand voice:** technical, direct, no marketing fluff.\n` +
  `**Audience:** senior engineers, eng leads, CTOs at SaaS companies.\n` +
  `**Differentiators:** IDE-native, multi-agent code review, customizable Kody Rules, MCP integrations, open-source.\n`;

function buildLlmPrompt({
  kind,
  startDate,
  endDate,
  body,
}: {
  kind: LlmTaskKind;
  startDate: string;
  endDate: string;
  body: string;
}): string {
  return (
    `${LLM_BRAND_PREAMBLE}\n` +
    `**Period analyzed:** ${startDate} → ${endDate}\n` +
    `**Issue type:** ${LLM_TASK_LABELS[kind]}\n\n` +
    `${body}\n\n` +
    `---\n\n` +
    `# Now produce\n\n${LLM_TASKS[kind]}\n\n` +
    `Output as markdown with clear H2/H3 sections. Be concrete (no "consider X") — make decisions and explain why.`
  );
}

// Single three-dot menu shown at the end of every actionable row. Opens a
// popover with two actions: copy a fully contextualized LLM prompt, or create
// a card on the Kanban. Replaces the inline two-button row to keep the table
// dense.
function RowActionsMenu({
  llmPrompt,
  pending,
  actioned,
  canCreateCard,
  onCreate,
}: {
  llmPrompt: string;
  pending: boolean;
  actioned: boolean;
  canCreateCard: boolean;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(llmPrompt);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setOpen(false);
      }, 900);
    } catch (err) {
      console.error("[dashboard] copy LLM prompt error:", err);
    }
  }, [llmPrompt]);

  const handleCreate = useCallback(() => {
    if (!canCreateCard || pending || actioned) return;
    onCreate();
    setOpen(false);
  }, [canCreateCard, pending, actioned, onCreate]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-md border transition",
            "border-white/10 bg-white/[0.04] text-neutral-400 hover:border-white/20 hover:bg-white/[0.08] hover:text-white",
            actioned && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
          )}
          title="More actions"
          aria-label="Row actions"
        >
          {actioned ? (
            <Check className="size-3.5" />
          ) : (
            <MoreHorizontal className="size-3.5" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="w-60 rounded-md border-white/10 bg-neutral-950/95 p-1 shadow-xl backdrop-blur"
      >
        <button
          onClick={handleCopy}
          className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[12px] text-neutral-200 transition hover:bg-white/[0.06] hover:text-white"
        >
          <span className="mt-0.5">
            {copied ? (
              <ClipboardCheck className="size-3.5 text-sky-300" />
            ) : (
              <Clipboard className="size-3.5" />
            )}
          </span>
          <div className="flex flex-1 flex-col">
            <span>{copied ? "Copied — paste in your LLM" : "Copy LLM prompt"}</span>
            {!copied && (
              <span className="text-[10px] text-neutral-500">
                Brand context + row data + task spec
              </span>
            )}
          </div>
        </button>
        <button
          onClick={handleCreate}
          disabled={!canCreateCard || pending || actioned}
          className={cn(
            "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[12px] transition",
            !canCreateCard || pending || actioned
              ? "text-neutral-500"
              : "text-neutral-200 hover:bg-white/[0.06] hover:text-white",
          )}
        >
          <span className="mt-0.5">
            {actioned ? (
              <Check className="size-3.5 text-emerald-300" />
            ) : (
              <Plus className="size-3.5" />
            )}
          </span>
          <span>
            {actioned
              ? "Card created"
              : pending
                ? "Creating..."
                : "Create card on Kanban"}
          </span>
        </button>
      </PopoverContent>
    </Popover>
  );
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
  const { createCard, actioned, pending, ready: canCreateCard } =
    useCardCreator();

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
                        <TableHead className="text-right text-neutral-400">Impr</TableHead>
                        <TableHead className="text-right text-neutral-400">Pos</TableHead>
                        <TableHead className="text-right text-neutral-400 w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.opportunities.strikingDistance.slice(0, 8).map((r) => {
                        const rowKey = `striking:${r.query}:${r.page}`;
                        const description =
                          `## Striking distance opportunity\n\n` +
                          `- **Query**: \`${r.query}\`\n` +
                          `- **Page**: ${r.page}\n` +
                          `- **Position**: ${r.position.toFixed(1)} (page 1 = top 10)\n` +
                          `- **Impressions (period)**: ${formatNumber(r.impressions)}\n` +
                          `- **CTR**: ${formatPercent(r.ctr)}\n\n` +
                          `## What to do\n\n` +
                          `Optimize on-page for this query — title, H1, internal links pointing here. Often a small position bump (e.g. 12 → 8) unlocks 3-5x clicks.\n\n` +
                          `## Done when\n\n` +
                          `- [ ] Page revisited; H1/title aligned with the query\n` +
                          `- [ ] At least 3 internal links from related pages added\n` +
                          `- [ ] GSC URL Inspection submitted\n` +
                          `- [ ] Re-check position in 14d`;
                        const llmPrompt = buildLlmPrompt({
                          kind: "striking",
                          startDate: data.startDate,
                          endDate: data.endDate,
                          body: description,
                        });
                        return (
                          <TableRow key={rowKey} className="border-white/5">
                            <TableCell
                              className="max-w-[180px] truncate text-neutral-200"
                              title={r.query}
                            >
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
                            <TableCell className="text-right">
                              <RowActionsMenu
                                llmPrompt={llmPrompt}
                                pending={pending.has(rowKey)}
                                actioned={actioned.has(rowKey)}
                                canCreateCard={canCreateCard}
                                onCreate={() =>
                                  createCard(rowKey, {
                                    title: `[Push to top 10] ${shortenUrlPath(r.page)} — "${r.query}"`,
                                    itemType: "update",
                                    priority: r.impressions > 1000 ? "high" : "medium",
                                    link: r.page,
                                    description,
                                  })
                                }
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
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
                        <TableHead className="text-right text-neutral-400">Impr</TableHead>
                        <TableHead className="text-right text-neutral-400">CTR</TableHead>
                        <TableHead className="text-right text-neutral-400 w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.opportunities.lowCtr.slice(0, 8).map((r) => {
                        const rowKey = `lowctr:${r.query}:${r.page}`;
                        const description =
                          `## CTR fix opportunity\n\n` +
                          `- **Query**: \`${r.query}\`\n` +
                          `- **Page**: ${r.page}\n` +
                          `- **Impressions (period)**: ${formatNumber(r.impressions)}\n` +
                          `- **CTR**: ${formatPercent(r.ctr)} (target: ≥2%)\n` +
                          `- **Position**: ${formatPosition(r.position)}\n\n` +
                          `## What to do\n\n` +
                          `Rewrite **title** (<60 chars), **meta description** (<155 chars), and add **FAQ schema** (5+ Q&As). Run \`/ctr-fix ${r.page}\` for an AI-assisted draft.\n\n` +
                          `## Done when\n\n` +
                          `- [ ] Title + meta updated in WordPress\n` +
                          `- [ ] FAQPage schema validated in [Rich Results Test](https://search.google.com/test/rich-results)\n` +
                          `- [ ] GSC URL Inspection submitted\n` +
                          `- [ ] Re-measure CTR after 30d (target ≥1.5%)`;
                        const llmPrompt = buildLlmPrompt({
                          kind: "lowctr",
                          startDate: data.startDate,
                          endDate: data.endDate,
                          body: description,
                        });
                        return (
                          <TableRow key={rowKey} className="border-white/5">
                            <TableCell
                              className="max-w-[180px] truncate text-neutral-200"
                              title={r.query}
                            >
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
                            <TableCell className="text-right">
                              <RowActionsMenu
                                llmPrompt={llmPrompt}
                                pending={pending.has(rowKey)}
                                actioned={actioned.has(rowKey)}
                                canCreateCard={canCreateCard}
                                onCreate={() =>
                                  createCard(rowKey, {
                                    title: `[CTR fix] ${shortenUrlPath(r.page)} — "${r.query}"`,
                                    itemType: "update",
                                    priority: r.impressions > 1000 ? "high" : "medium",
                                    link: r.page,
                                    description,
                                  })
                                }
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
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
                    <TableHead className="text-right text-neutral-400 w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.decay.decaying.slice(0, 10).map((d) => {
                    const rowKey = `decay:${d.page}`;
                    const description =
                      `## Content decay\n\n` +
                      `- **Page**: ${d.page}\n` +
                      `- **Pageviews (previous period)**: ${formatNumber(d.previousPageviews)}\n` +
                      `- **Pageviews (current period)**: ${formatNumber(d.currentPageviews)}\n` +
                      `- **Change**: ${formatChangePercent(d.changePercent)}\n\n` +
                      `## Decision\n\n` +
                      `Pick one path:\n\n` +
                      `- **Rewrite** if topic is strategic + recoverable. Use \`/brief-listicle-2026\` or \`/brief-alternative\` if applicable.\n` +
                      `- **301 to closer hub** if topic is off-brand or covered better by another page.\n` +
                      `- **410 / deprecate** if no recovery angle.\n\n` +
                      `## Done when\n\n` +
                      `- [ ] Decision documented (rewrite / 301 / 410)\n` +
                      `- [ ] Action shipped\n` +
                      `- [ ] GSC URL Inspection submitted\n` +
                      `- [ ] Re-check pageviews in 30d`;
                    const llmPrompt = buildLlmPrompt({
                      kind: "decay",
                      startDate: data.startDate,
                      endDate: data.endDate,
                      body: description,
                    });
                    return (
                      <TableRow key={rowKey} className="border-white/5">
                        <TableCell
                          className="max-w-[260px] truncate text-neutral-200"
                          title={d.page}
                        >
                          {shortenUrlPath(d.page)}
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
                        <TableCell className="text-right">
                          <RowActionsMenu
                            llmPrompt={llmPrompt}
                            pending={pending.has(rowKey)}
                            actioned={actioned.has(rowKey)}
                            canCreateCard={canCreateCard}
                            onCreate={() =>
                              createCard(rowKey, {
                                title: `[Decay ${formatChangePercent(d.changePercent)}] ${shortenUrlPath(d.page)}`,
                                itemType: "update",
                                priority:
                                  Math.abs(d.changePercent) > 50
                                    ? "high"
                                    : "medium",
                                link: d.page,
                                description,
                              })
                            }
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Cannibalization */}
      {!loading && data && data.cannibalization.items.length > 0 && (
        <Card className="border-white/[0.06] bg-neutral-900/50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium text-yellow-300">
                Cannibalization
              </CardTitle>
              <Badge
                variant="outline"
                className="border-yellow-500/30 text-yellow-300 text-[10px]"
              >
                {data.cannibalization.items.length} queries
              </Badge>
            </div>
            <p className="text-xs text-neutral-500">
              Queries where 2+ kodus.io pages compete — pick a canonical, 301
              the rest, or add internal links to lift the chosen page.
            </p>
          </CardHeader>
          <CardContent>
            <div>
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10">
                    <TableHead className="text-neutral-400">Query</TableHead>
                    <TableHead className="text-right text-neutral-400">Pages</TableHead>
                    <TableHead className="text-right text-neutral-400">Impr</TableHead>
                    <TableHead className="text-right text-neutral-400">Avg pos</TableHead>
                    <TableHead className="text-right text-neutral-400 w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.cannibalization.items.slice(0, 10).map((c) => {
                    const rowKey = `cann:${c.query}`;
                    const description =
                      `## Cannibalization\n\n` +
                      `- **Query**: \`${c.query}\`\n` +
                      `- **Pages competing (${c.numPages})**:\n` +
                      c.pages.map((p) => `  - ${p}`).join("\n") +
                      `\n- **Combined impressions (period)**: ${formatNumber(c.totalImpressions)}\n` +
                      `- **Combined clicks**: ${formatNumber(c.totalClicks)}\n` +
                      `- **Avg position**: ${formatPosition(c.avgPosition)}\n\n` +
                      `## Decision\n\n` +
                      `Pick one path:\n\n` +
                      `- **Canonical + 301**: pick the strongest page (highest engagement / clicks / position) and 301 the others to it\n` +
                      `- **Lift the chosen page**: keep all but ensure target page has the most internal links + best on-page for this query\n` +
                      `- **Differentiate**: rewrite competing pages to target distinct intents (rare — usually canonical wins)\n\n` +
                      `## Done when\n\n` +
                      `- [ ] Decision documented\n` +
                      `- [ ] 301s applied OR internal-link sweep done\n` +
                      `- [ ] GSC URL Inspection submitted on chosen canonical\n` +
                      `- [ ] Re-check SERP for query in 14d`;
                    const llmPrompt = buildLlmPrompt({
                      kind: "cannibalization",
                      startDate: data.startDate,
                      endDate: data.endDate,
                      body: description,
                    });
                    return (
                      <TableRow key={rowKey} className="border-white/5">
                        <TableCell
                          className="max-w-[260px] truncate text-neutral-200"
                          title={`${c.query}\n\n${c.pages.join("\n")}`}
                        >
                          {c.query}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {c.numPages}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatNumber(c.totalImpressions)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatPosition(c.avgPosition)}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            llmPrompt={llmPrompt}
                            pending={pending.has(rowKey)}
                            actioned={actioned.has(rowKey)}
                            canCreateCard={canCreateCard}
                            onCreate={() =>
                              createCard(rowKey, {
                                title: `[Cannibalization] "${c.query}" — ${c.numPages} pages competing`,
                                itemType: "task",
                                priority:
                                  c.totalImpressions > 1000 ? "high" : "medium",
                                description,
                              })
                            }
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Internal link gap */}
      {!loading && data && data.internalLinkGaps.candidates.length > 0 && (
        <Card className="border-white/[0.06] bg-neutral-900/50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium text-cyan-300">
                Internal link gaps
              </CardTitle>
              <Badge
                variant="outline"
                className="border-cyan-500/30 text-cyan-300 text-[10px]"
              >
                {data.internalLinkGaps.candidates.length} pages
              </Badge>
            </div>
            <p className="text-xs text-neutral-500">
              Commercial pages with low traffic — likely under-linked. Add 3-5
              inbound internal links to lift them. (Heuristic: pos &gt; 10, CTR
              &lt; 1.5%, &lt; 200 impressions in period.)
            </p>
          </CardHeader>
          <CardContent>
            <div>
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10">
                    <TableHead className="text-neutral-400">Page</TableHead>
                    <TableHead className="text-right text-neutral-400">Impr</TableHead>
                    <TableHead className="text-right text-neutral-400">Clicks</TableHead>
                    <TableHead className="text-right text-neutral-400">Pos</TableHead>
                    <TableHead className="text-right text-neutral-400 w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.internalLinkGaps.candidates.slice(0, 10).map((g) => {
                    const rowKey = `linkgap:${g.page}`;
                    const description =
                      `## Internal link gap\n\n` +
                      `- **Page**: ${g.page}\n` +
                      `- **Impressions (period)**: ${formatNumber(g.impressions)}\n` +
                      `- **Clicks**: ${formatNumber(g.clicks)}\n` +
                      `- **Avg position**: ${formatPosition(g.avgPosition)} (target: top 10)\n\n` +
                      `## What to do\n\n` +
                      `Add 3-5 inbound internal links from related pages. Run \`/internal-link-suggest ${g.page}\` for AI-suggested anchors + paragraph context.\n\n` +
                      `Likely sources for inbound links:\n` +
                      `- Other \`/alternative\` pages in the same niche\n` +
                      `- The home page or \`/ai-code-review\` landing\n` +
                      `- The relevant microsite (aicodereviews.io / codereviewbench.com)\n` +
                      `- The awesome-ai-code-review README\n\n` +
                      `## Done when\n\n` +
                      `- [ ] 3+ inbound internal links added\n` +
                      `- [ ] GSC URL Inspection re-submitted\n` +
                      `- [ ] Re-check position in 14d`;
                    const llmPrompt = buildLlmPrompt({
                      kind: "linkgap",
                      startDate: data.startDate,
                      endDate: data.endDate,
                      body: description,
                    });
                    return (
                      <TableRow key={rowKey} className="border-white/5">
                        <TableCell
                          className="max-w-[300px] truncate text-neutral-200"
                          title={g.page}
                        >
                          {shortenUrlPath(g.page)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatNumber(g.impressions)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatNumber(g.clicks)}
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatPosition(g.avgPosition)}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            llmPrompt={llmPrompt}
                            pending={pending.has(rowKey)}
                            actioned={actioned.has(rowKey)}
                            canCreateCard={canCreateCard}
                            onCreate={() =>
                              createCard(rowKey, {
                                title: `[Internal links] ${shortenUrlPath(g.page)}`,
                                itemType: "task",
                                priority: "medium",
                                link: g.page,
                                description,
                              })
                            }
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
