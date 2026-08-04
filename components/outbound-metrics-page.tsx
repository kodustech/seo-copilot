"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type {
  OutboundAlert,
  OutboundMetrics,
} from "@/lib/outreach/metrics";
import { cn } from "@/lib/utils";

// Ordered so the chips read as a funnel, best outcome first. Bounce and
// auto_reply sit at the end because they are not replies in any useful sense.
const CLASS_ORDER = [
  "positive",
  "neutral",
  "not_now",
  "referral",
  "not_interested",
  "unsubscribe",
  "auto_reply",
  "bounce",
  "unclassified",
] as const;

const CLASS_LABELS: Record<string, string> = {
  positive: "Positive",
  neutral: "Neutral",
  not_now: "Not now",
  referral: "Referral",
  not_interested: "Not interested",
  unsubscribe: "Unsubscribe",
  auto_reply: "Auto-reply",
  bounce: "Bounce",
  unclassified: "Unclassified",
};

const CLASS_COLORS: Record<string, string> = {
  positive: "bg-emerald-500",
  neutral: "bg-sky-500",
  not_now: "bg-amber-500",
  referral: "bg-violet-500",
  not_interested: "bg-neutral-500",
  unsubscribe: "bg-red-500",
  auto_reply: "bg-neutral-700",
  bounce: "bg-red-900",
  unclassified: "bg-neutral-800",
};

const PIPELINE_ORDER = [
  "lead",
  "engaged",
  "qualified",
  "poc",
  "negotiation",
  "customer",
  "lost",
  "churned",
];

function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(digits)}%`;
}

function int(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return value.toLocaleString("en-US");
}

function hours(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value < 48) return `${Math.round(value)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

function money(value: number | null | undefined): string {
  if (!value) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function SectionHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-3 pb-1 pt-6 first:pt-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </h2>
      {hint && <p className="text-[11px] text-neutral-600">{hint}</p>}
      <div className="h-px flex-1 bg-white/[0.06]" />
    </div>
  );
}

function Kpi({
  title,
  value,
  sub,
  tone = "neutral",
  loading,
}: {
  title: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "good" | "bad";
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        {title}
      </p>
      <div className="mt-1.5">
        {loading ? (
          <Skeleton className="h-7 w-20 bg-neutral-800" />
        ) : (
          <>
            <p
              className={cn(
                "text-xl font-semibold tracking-tight",
                tone === "good" && "text-emerald-400",
                tone === "bad" && "text-red-400",
                tone === "neutral" && "text-white",
              )}
            >
              {value}
            </p>
            {sub && <p className="mt-1 text-[11px] text-neutral-500">{sub}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function AlertBanner({ alerts }: { alerts: OutboundAlert[] }) {
  if (!alerts.length) return null;
  return (
    <div className="space-y-2">
      {alerts.map((alert, i) => (
        <div
          key={i}
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]",
            alert.level === "danger"
              ? "border-red-500/25 bg-red-500/[0.07] text-red-200"
              : "border-amber-500/25 bg-amber-500/[0.06] text-amber-200",
          )}
        >
          {alert.level === "danger" ? (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>{alert.message}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal stacked bar + legend for the reply-class mix. */
function ClassBreakdown({
  classes,
}: {
  classes: Record<string, number | undefined>;
}) {
  const entries = CLASS_ORDER.map((key) => ({
    key,
    label: CLASS_LABELS[key],
    value: classes[key] ?? 0,
  })).filter((e) => e.value > 0);

  const total = entries.reduce((sum, e) => sum + e.value, 0);

  if (!total) {
    return (
      <p className="rounded-lg border border-white/[0.06] bg-neutral-900/40 p-4 text-[13px] text-neutral-500">
        No inbound replies in this window.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40 p-4">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-800">
        {entries.map((e) => (
          <div
            key={e.key}
            className={CLASS_COLORS[e.key]}
            style={{ width: `${(e.value / total) * 100}%` }}
            title={`${e.label}: ${e.value}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {entries.map((e) => (
          <div key={e.key} className="flex items-center gap-1.5 text-[12px]">
            <span
              className={cn("h-2 w-2 rounded-full", CLASS_COLORS[e.key])}
            />
            <span className="text-neutral-300">{e.label}</span>
            <span className="text-neutral-500">
              {e.value} · {((e.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type SequenceOption = { id: string; name: string };

export function OutboundMetricsPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [days, setDays] = useState("30");
  const [sequenceId, setSequenceId] = useState("all");
  const [sequences, setSequences] = useState<SequenceOption[]>([]);
  const [metrics, setMetrics] = useState<OutboundMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/outreach/metrics?days=${days}&sequenceId=${sequenceId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load metrics");
      setMetrics(json.metrics as OutboundMetrics);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load metrics");
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, [token, days, sequenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Sequence filter options come from the sequences list, not the metrics
  // payload, so a sequence with zero sends this window is still selectable.
  useEffect(() => {
    if (!token) return;
    fetch("/api/outreach/sequences", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!json?.sequences) return;
        setSequences(
          (json.sequences as Array<{ id: string; name: string }>).map((s) => ({
            id: s.id,
            name: s.name,
          })),
        );
      })
      .catch(() => {
        /* filter stays on "all" */
      });
  }, [token]);

  async function runClassifier() {
    if (!token || classifying) return;
    setClassifying(true);
    setError(null);
    try {
      const res = await fetch("/api/outreach/inbox/classify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 100 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `Classification failed (${res.status})`);
      }
      // Per-thread failures do not fail the request; say so rather than
      // reloading into unchanged numbers and looking like nothing happened.
      if (json.failed > 0) {
        setError(
          `Classified ${json.classified} of ${json.scanned}; ${json.failed} failed. ${
            json.errors?.[0] ?? ""
          }`.trim(),
        );
      }
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Classification failed",
      );
    } finally {
      setClassifying(false);
    }
  }

  const m = metrics;
  const funnel = m?.funnel;
  const volume = m?.volume;
  const hygiene = m?.hygiene;
  const pipeline = m?.pipeline;

  const bounceTone =
    m?.rates.bounceRate == null
      ? "neutral"
      : m.rates.bounceRate > 0.02
        ? "bad"
        : "good";

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="h-8 w-[120px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
            <SelectItem value="365">Last 12 months</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sequenceId} onValueChange={setSequenceId}>
          <SelectTrigger className="h-8 w-[220px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sequences</SelectItem>
            {sequences.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        {!!hygiene?.unclassified_threads && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[13px]"
            onClick={runClassifier}
            disabled={classifying}
          >
            <Sparkles
              className={cn("mr-1.5 h-3.5 w-3.5", classifying && "animate-pulse")}
            />
            Classify {hygiene.unclassified_threads} repl
            {hygiene.unclassified_threads === 1 ? "y" : "ies"}
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          className="h-8 text-[13px]"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-[13px] text-red-200">
          {error}
        </div>
      )}

      {!!m?.alerts.length && (
        <div className="mb-5">
          <AlertBanner alerts={m.alerts} />
        </div>
      )}

      {/* ── Funnel ─────────────────────────────────────────────── */}
      <SectionHeader
        label="Funnel"
        hint="Cohort: contacts whose first send landed in this window"
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi
          loading={loading}
          title="Contacted"
          value={int(funnel?.contacted)}
          sub={`${int(volume?.total_sent)} sends total`}
        />
        <Kpi
          loading={loading}
          title="Reply rate"
          value={pct(m?.rates.replyRate)}
          sub={`${int(funnel?.replied)} replied`}
        />
        <Kpi
          loading={loading}
          title="Positive rate"
          value={pct(m?.rates.positiveRate)}
          sub={`${int(m?.positiveReplies)} of ${int(m?.humanReplies)} human replies`}
          tone="good"
        />
        <Kpi
          loading={loading}
          title="Bounce rate"
          value={pct(m?.rates.bounceRate)}
          sub={`${int(funnel?.bounced)} bounced`}
          tone={bounceTone}
        />
        <Kpi
          loading={loading}
          title="Time to reply"
          value={hours(m?.speed.median_hours)}
          sub={`median · p90 ${hours(m?.speed.p90_hours)}`}
        />
        <Kpi
          loading={loading}
          title="Still in flight"
          value={int(funnel?.in_flight)}
          sub={`${int(funnel?.completed_no_reply)} finished silent`}
        />
      </div>

      {/* ── Reply mix ──────────────────────────────────────────── */}
      <SectionHeader
        label="Reply mix"
        hint="Raw reply counts mix intent with autoresponders — this splits them"
      />
      {loading ? (
        <Skeleton className="h-24 w-full bg-neutral-900" />
      ) : (
        <ClassBreakdown classes={m?.reply_classes ?? {}} />
      )}

      {/* ── Volume ─────────────────────────────────────────────── */}
      <SectionHeader label="Volume" hint="What actually went out" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi loading={loading} title="Emails sent" value={int(volume?.emails_sent)} />
        <Kpi
          loading={loading}
          title="LinkedIn done"
          value={int(volume?.linkedin_sent)}
          sub={`${int(volume?.semi_sent)} manual steps`}
        />
        <Kpi
          loading={loading}
          title="Enrolled"
          value={int(m?.enrollment.created)}
          sub={`${int(m?.enrollment.active_now)} active now`}
        />
        <Kpi
          loading={loading}
          title="Auto-enrolled"
          value={int(
            (m?.enrollment.from_research ?? 0) + (m?.enrollment.from_outreach ?? 0),
          )}
          sub={`${int(m?.enrollment.from_manual)} manual`}
        />
        <Kpi
          loading={loading}
          title="Send failures"
          value={pct(m?.rates.sendFailureRate)}
          sub={`${int(volume?.tasks_failed)} tasks errored`}
          tone={
            (m?.rates.sendFailureRate ?? 0) > 0.02 ? "bad" : "neutral"
          }
        />
        <Kpi
          loading={loading}
          title="Contacts touched"
          value={int(volume?.contacts_touched)}
        />
      </div>

      {/* ── Daily ──────────────────────────────────────────────── */}
      <SectionHeader label="Daily" hint="Sends vs replies" />
      <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40 p-4">
        {loading ? (
          <Skeleton className="h-56 w-full bg-neutral-800" />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={m?.daily ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: "#737373", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: "#737373", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                contentStyle={{
                  background: "#0a0a0a",
                  border: "1px solid #ffffff14",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: "#a3a3a3" }} />
              <Bar dataKey="sent" name="Sent" fill="#3f3f46" radius={[2, 2, 0, 0]} />
              <Bar dataKey="replies" name="Replies" fill="#0ea5e9" radius={[2, 2, 0, 0]} />
              <Bar dataKey="positive" name="Positive" fill="#10b981" radius={[2, 2, 0, 0]} />
              <Bar dataKey="bounces" name="Bounces" fill="#ef4444" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Per step ───────────────────────────────────────────── */}
      <SectionHeader
        label="By step"
        hint="A reply is credited to the last step sent before it arrived"
      />
      <div className="overflow-hidden rounded-lg border border-white/[0.06] bg-neutral-900/40">
        <Table>
          <TableHeader>
            <TableRow className="border-white/[0.06] hover:bg-transparent">
              <TableHead className="text-[11px] uppercase tracking-wider">Step</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Sent</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Replies</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Positive</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Reply / send</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(m?.by_step ?? []).map((row) => (
              <TableRow key={row.position} className="border-white/[0.04]">
                <TableCell className="text-[13px] text-neutral-300">
                  Step {row.position + 1}
                </TableCell>
                <TableCell className="text-right text-[13px]">{int(row.sent)}</TableCell>
                <TableCell className="text-right text-[13px]">{int(row.replies)}</TableCell>
                <TableCell className="text-right text-[13px] text-emerald-400">
                  {int(row.positive)}
                </TableCell>
                <TableCell className="text-right text-[13px] text-neutral-400">
                  {row.sent ? pct(row.replies / row.sent) : "—"}
                </TableCell>
              </TableRow>
            ))}
            {!loading && !(m?.by_step ?? []).length && (
              <TableRow>
                <TableCell colSpan={5} className="text-[13px] text-neutral-500">
                  Nothing sent in this window.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Per sequence ───────────────────────────────────────── */}
      <SectionHeader label="By sequence" />
      <div className="overflow-hidden rounded-lg border border-white/[0.06] bg-neutral-900/40">
        <Table>
          <TableHeader>
            <TableRow className="border-white/[0.06] hover:bg-transparent">
              <TableHead className="text-[11px] uppercase tracking-wider">Sequence</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Sent</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Contacts</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Replies</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Positive</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Bounces</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(m?.by_sequence ?? []).map((row) => (
              <TableRow key={row.sequence_id} className="border-white/[0.04]">
                <TableCell className="text-[13px] text-neutral-300">
                  <span className="mr-2">{row.name}</span>
                  {row.status !== "active" && (
                    <Badge variant="outline" className="text-[10px]">
                      {row.status}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right text-[13px]">{int(row.sent)}</TableCell>
                <TableCell className="text-right text-[13px]">{int(row.contacts)}</TableCell>
                <TableCell className="text-right text-[13px]">
                  {int(row.replies)}
                  <span className="ml-1.5 text-neutral-500">
                    {row.contacts ? pct(row.replies / row.contacts, 0) : ""}
                  </span>
                </TableCell>
                <TableCell className="text-right text-[13px] text-emerald-400">
                  {int(row.positive)}
                </TableCell>
                <TableCell className="text-right text-[13px] text-red-400">
                  {int(row.bounces)}
                </TableCell>
              </TableRow>
            ))}
            {!loading && !(m?.by_sequence ?? []).length && (
              <TableRow>
                <TableCell colSpan={6} className="text-[13px] text-neutral-500">
                  No sequence activity in this window.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Pipeline ───────────────────────────────────────────── */}
      <SectionHeader
        label="Pipeline"
        hint="Accounts created by a sequence or touched by an outbound promotion"
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi
          loading={loading}
          title="Outbound accounts"
          value={int(pipeline?.accounts_total)}
          sub={`${int(pipeline?.created_in_window)} new this window`}
        />
        <Kpi
          loading={loading}
          title="Qualified (window)"
          value={int(pipeline?.entered_in_window?.qualified)}
          sub="entered the stage"
        />
        <Kpi
          loading={loading}
          title="Open ARR"
          value={money(pipeline?.arr_open)}
          sub="qualified + poc + negotiation"
        />
        <Kpi
          loading={loading}
          title="Won ARR"
          value={money(pipeline?.arr_won)}
          sub={`${int(pipeline?.by_status?.customer)} customers`}
          tone="good"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {PIPELINE_ORDER.map((status) => {
          const now = pipeline?.by_status?.[status] ?? 0;
          const entered = pipeline?.entered_in_window?.[status] ?? 0;
          if (!now && !entered) return null;
          return (
            <div
              key={status}
              className="rounded-md border border-white/[0.06] bg-neutral-900/40 px-3 py-2"
            >
              <p className="text-[11px] uppercase tracking-wider text-neutral-500">
                {status}
              </p>
              <p className="text-[15px] font-semibold text-white">{now}</p>
              {entered > 0 && (
                <p className="text-[11px] text-emerald-400">+{entered} in window</p>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Hygiene ────────────────────────────────────────────── */}
      <SectionHeader label="Machine health" hint="Is the engine actually running" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Kpi
          loading={loading}
          title="Manual queue"
          value={int(
            Object.values(hygiene?.ready_overdue ?? {}).reduce(
              (a: number, b) => a + (b ?? 0),
              0,
            ),
          )}
          sub={
            hygiene?.ready_oldest_hours
              ? `oldest ${hours(hygiene.ready_oldest_hours)}`
              : "nothing waiting"
          }
        />
        <Kpi
          loading={loading}
          title="Sends overdue"
          value={int(hygiene?.scheduled_overdue)}
          sub="cron lag"
          tone={(hygiene?.scheduled_overdue ?? 0) > 0 ? "bad" : "neutral"}
        />
        <Kpi
          loading={loading}
          title="Stalled enrollments"
          value={int(hygiene?.stalled_enrollments)}
          sub={`${int(hygiene?.enrollments_failed)} failed`}
        />
        <Kpi
          loading={loading}
          title="Unclassified replies"
          value={int(hygiene?.unclassified_threads)}
          sub={`${int(hygiene?.unmatched_threads)} unmatched this window`}
        />
        <Kpi
          loading={loading}
          title="Verified contacts"
          value={int(hygiene?.contact_coverage?.verified)}
          sub={`of ${int(hygiene?.contact_coverage?.with_email)} with email`}
        />
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-white/[0.06] bg-neutral-900/40">
        <Table>
          <TableHeader>
            <TableRow className="border-white/[0.06] hover:bg-transparent">
              <TableHead className="text-[11px] uppercase tracking-wider">Mailbox</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Today</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Cap</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-wider">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(hygiene?.mailboxes ?? []).map((box) => (
              <TableRow key={box.id} className="border-white/[0.04]">
                <TableCell className="text-[13px] text-neutral-300">
                  {box.from_email}
                  <span className="ml-2 text-neutral-600">{box.label}</span>
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right text-[13px]",
                    box.sent_today >= box.daily_cap && "text-amber-400",
                  )}
                >
                  {int(box.sent_today)}
                </TableCell>
                <TableCell className="text-right text-[13px] text-neutral-400">
                  {int(box.daily_cap)}
                </TableCell>
                <TableCell className="text-right text-[13px]">
                  {!box.enabled ? (
                    <span className="text-neutral-500">disabled</span>
                  ) : box.last_test_ok === false ? (
                    <span className="text-red-400">test failed</span>
                  ) : (
                    <span className="text-emerald-400">ok</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!loading && !(hygiene?.mailboxes ?? []).length && (
              <TableRow>
                <TableCell colSpan={4} className="text-[13px] text-neutral-500">
                  No mailbox connected.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="mt-6 text-[11px] leading-relaxed text-neutral-600">
        Open and click rate are not tracked on purpose: the sender adds no pixel
        and rewrites no links, and with Apple Mail Privacy Protection an open
        rate would be noise. Reply rate is the honest signal.
      </p>
    </div>
  );
}
