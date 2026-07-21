"use client";

/* Hallmark · Home / Command center redesign
 * genre: modern-minimal dark workspace · AI CMO day board
 * structure: snapshot strip → split (priority stack | motion rails) → streams
 * pre-emit critique: P4 H5 E4 S4 R4 V4
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  KanbanSquare,
  Loader2,
  Radar,
  RefreshCw,
  Target,
  Workflow,
  XCircle,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import type { AttentionItem, UserOverview } from "@/lib/user-center";

import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "—";
  if (days < 0) return `in ${-days}d`;
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function capitalize(s: string) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  crm_idle: "Accounts",
  kanban_overdue: "Kanban",
  outreach_followup: "Outbound",
  goal_at_risk: "Goals",
  job_failed: "Jobs",
  reply_pending: "Engage", // legacy; social inbox removed from product surface
};

// ---------------------------------------------------------------------------

export function UserCenterPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [overview, setOverview] = useState<UserOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) =>
      setToken(s?.access_token ?? null),
    );
    return () => subscription.unsubscribe();
  }, [supabase]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/me/overview", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setOverview(json.overview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const firstName = overview?.userEmail?.split("@")[0]?.split(".")[0] ?? "";
  const displayName = firstName ? capitalize(firstName) : "";

  const attentionBySeverity = useMemo(() => {
    if (!overview) return { error: [], warning: [], info: [] };
    const error: AttentionItem[] = [];
    const warning: AttentionItem[] = [];
    const info: AttentionItem[] = [];
    for (const a of overview.attention) {
      // Social inbox removed from product surface
      if (a.kind === "reply_pending") continue;
      if (a.severity === "error") error.push(a);
      else if (a.severity === "warning") warning.push(a);
      else info.push(a);
    }
    return { error, warning, info };
  }, [overview]);

  const topAction = useMemo(() => {
    if (!overview) return null;
    // Highest leverage signal first — real product priorities
    if (overview.kanban.overdue > 0) {
      return {
        href: "/kanban",
        label: "Unblock overdue work",
        detail: `${overview.kanban.overdue} cards past due`,
        tone: "amber" as const,
      };
    }
    if (overview.goals.atRisk > 0) {
      return {
        href: "/goals",
        label: "Review goals at risk",
        detail: `${overview.goals.atRisk} behind expected pace`,
        tone: "amber" as const,
      };
    }
    if (overview.crm.idle > 0) {
      return {
        href: "/crm",
        label: "Touch idle accounts",
        detail: `${overview.crm.idle} quiet accounts`,
        tone: "amber" as const,
      };
    }
    if (overview.outreach.followupDue > 0) {
      return {
        href: "/crm",
        label: "Review accounts",
        detail: `${overview.outreach.followupDue} legacy follow-ups · open Accounts`,
        tone: "sky" as const,
      };
    }
    return {
      href: "/sequences",
      label: "Open outbound",
      detail: "Work today's sequence queue",
      tone: "neutral" as const,
    };
  }, [overview]);

  return (
    <div className="mx-auto min-h-0 w-full max-w-6xl px-4 py-6 sm:px-6">
      {/* Masthead */}
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.06] pb-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white text-balance sm:text-3xl">
            {displayName ? `${displayName}'s day` : "Your day"}
          </h1>
          <p className="mt-1 max-w-lg text-sm text-pretty text-neutral-500">
            Command view across Attract, Engage, and Convert — what needs you
            now.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="h-9 shrink-0 gap-1.5 border-white/10 bg-transparent text-neutral-300 hover:bg-white/[0.04] hover:text-white"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !overview ? (
        <div className="flex justify-center py-24">
          <Loader2 className="size-6 animate-spin text-neutral-500" />
        </div>
      ) : overview ? (
        <div className="space-y-8">
          {/* Snapshot metrics — real counts only */}
          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.04] sm:grid-cols-4">
            <Snap
              label="Attention"
              value={overview.attention.filter((a) => a.kind !== "reply_pending").length}
              hint="items open"
              href="#attention"
              hot={overview.attention.some((a) => a.kind !== "reply_pending")}
            />
            <Snap
              label="Idle accounts"
              value={overview.crm.idle}
              hint={`${overview.crm.total} accounts`}
              href="/crm"
              hot={overview.crm.idle > 0}
            />
            <Snap
              label="Kanban overdue"
              value={overview.kanban.overdue}
              hint={`${overview.kanban.pending} open cards`}
              href="/kanban"
              hot={overview.kanban.overdue > 0}
            />
            <Snap
              label="Goals at risk"
              value={overview.goals.atRisk}
              hint={`${overview.goals.total} active`}
              href="/goals"
              hot={overview.goals.atRisk > 0}
            />
          </section>

          {/* Split: priority + primary action / motions */}
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            {/* Priority stack */}
            <section id="attention" className="min-w-0">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">
                  Priority stack
                </h2>
                <span className="text-xs tabular-nums text-neutral-500">
                  {overview.attention.length} open
                </span>
              </div>

              {overview.attention.length === 0 ? (
                <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-5">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-400" />
                  <div>
                    <p className="text-sm font-medium text-emerald-200">
                      All clear
                    </p>
                    <p className="mt-0.5 text-sm text-pretty text-emerald-200/70">
                      Nothing urgent on your plate. Use the motion rails to push
                      outbound, content, or social.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-neutral-950/40">
                  {(["error", "warning", "info"] as const).map((sev) => {
                    const items = attentionBySeverity[sev];
                    if (items.length === 0) return null;
                    return (
                      <div key={sev}>
                        <div className="flex items-center gap-2 border-b border-white/[0.04] bg-white/[0.02] px-3 py-1.5">
                          {sev === "error" ? (
                            <XCircle className="size-3 text-red-400" />
                          ) : sev === "warning" ? (
                            <AlertTriangle className="size-3 text-amber-400" />
                          ) : (
                            <Clock className="size-3 text-sky-400" />
                          )}
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                            {sev === "error"
                              ? "Blocking"
                              : sev === "warning"
                                ? "At risk"
                                : "Queue"}
                          </span>
                          <span className="text-[10px] tabular-nums text-neutral-600">
                            {items.length}
                          </span>
                        </div>
                        <ul className="divide-y divide-white/[0.04]">
                          {items.map((a, idx) => (
                            <li key={a.dedupeKey}>
                              <Link
                                href={a.link}
                                className="group flex items-start gap-3 px-3 py-3 transition hover:bg-white/[0.03]"
                              >
                                <span
                                  className={cn(
                                    "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums",
                                    sev === "error" &&
                                      "bg-red-500/15 text-red-300",
                                    sev === "warning" &&
                                      "bg-amber-500/15 text-amber-300",
                                    sev === "info" &&
                                      "bg-sky-500/15 text-sky-300",
                                  )}
                                >
                                  {idx + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                                      {KIND_LABEL[a.kind] ?? a.source}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-sm font-medium leading-snug text-neutral-100 text-pretty">
                                    {a.title}
                                  </p>
                                  {a.body && (
                                    <p className="mt-0.5 text-xs text-neutral-500 text-pretty">
                                      {a.body}
                                    </p>
                                  )}
                                </div>
                                <ArrowUpRight className="mt-1 size-3.5 shrink-0 text-neutral-600 transition group-hover:text-neutral-300" />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}

              {topAction && (
                <Link
                  href={topAction.href}
                  className={cn(
                    "mt-3 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 transition",
                    topAction.tone === "sky" &&
                      "border-sky-500/25 bg-sky-500/[0.08] hover:bg-sky-500/[0.12]",
                    topAction.tone === "amber" &&
                      "border-amber-500/25 bg-amber-500/[0.08] hover:bg-amber-500/[0.12]",
                    topAction.tone === "neutral" &&
                      "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]",
                  )}
                >
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {topAction.label}
                    </p>
                    <p className="text-xs text-neutral-400">{topAction.detail}</p>
                  </div>
                  <span className="text-xs font-medium text-neutral-300">
                    Go →
                  </span>
                </Link>
              )}
            </section>

            {/* Motion rails */}
            <section className="min-w-0 space-y-3">
              <h2 className="text-sm font-semibold text-white">Motions</h2>

              <MotionRail
                motion="Convert"
                description="Outbound & pipeline"
                items={[
                  {
                    href: "/sequences",
                    icon: Workflow,
                    title: "Outbound",
                    stat: "Today queue",
                  },
                  {
                    href: "/crm",
                    icon: Building2,
                    title: "Accounts",
                    stat: `${overview.crm.total}`,
                    alert:
                      overview.crm.idle > 0
                        ? `${overview.crm.idle} idle`
                        : null,
                  },
                  {
                    href: "/sequences",
                    icon: Workflow,
                    title: "Outbound",
                    stat: "queue",
                    alert: null,
                  },
                ]}
              />

              <MotionRail
                motion="Engage"
                description="Social presence"
                items={[
                  {
                    href: "/social-monitoring",
                    icon: Radar,
                    title: "Social monitor",
                    stat: "live",
                    alert: null,
                  },
                ]}
              />

              <MotionRail
                motion="Command"
                description="Execution"
                items={[
                  {
                    href: "/kanban",
                    icon: KanbanSquare,
                    title: "Kanban",
                    stat: `${overview.kanban.pending}`,
                    alert:
                      overview.kanban.overdue > 0
                        ? `${overview.kanban.overdue} overdue`
                        : null,
                  },
                  {
                    href: "/goals",
                    icon: Target,
                    title: "Goals",
                    stat: `${overview.goals.total}`,
                    alert:
                      overview.goals.atRisk > 0
                        ? `${overview.goals.atRisk} at risk`
                        : null,
                  },
                  {
                    href: "/jobs",
                    icon: Clock,
                    title: "Jobs",
                    stat: `${overview.jobs.total}`,
                    alert:
                      overview.jobs.failing > 0
                        ? `${overview.jobs.failing} failing`
                        : null,
                  },
                ]}
              />
            </section>
          </div>

          {/* Work streams — denser, not equal feature grid */}
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-white">
                Open work
              </h2>
              <p className="text-xs text-neutral-600">
                Latest items on your plate
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <StreamPanel
                href="/kanban"
                title="Kanban"
                empty={overview.kanban.items.length === 0}
              >
                {overview.kanban.items.slice(0, 5).map((i) => (
                  <StreamRow
                    key={i.id}
                    label={i.title}
                    tag={i.stage}
                    danger={i.overdue}
                  />
                ))}
              </StreamPanel>
              <StreamPanel
                href="/goals"
                title="Goals"
                empty={overview.goals.items.length === 0}
              >
                {overview.goals.items.slice(0, 5).map((g) => (
                  <StreamRow
                    key={g.id}
                    label={g.title}
                    tag={`${Math.round(g.progress * 100)}%`}
                    danger={g.atRisk}
                  />
                ))}
              </StreamPanel>
              <StreamPanel
                href="/crm"
                title="Accounts"
                empty={overview.crm.companies.length === 0}
              >
                {overview.crm.companies.slice(0, 5).map((c) => (
                  <StreamRow
                    key={c.id}
                    label={c.name}
                    tag={c.status}
                    danger={c.isStale}
                  />
                ))}
              </StreamPanel>
              <StreamPanel
                href="/sequences"
                title="Outbound"
                empty={false}
              >
                <StreamRow
                  label="Today queue"
                  tag="sequences"
                  danger={false}
                />
              </StreamPanel>
            </div>
          </section>

          <p className="flex items-center gap-1.5 text-xs text-neutral-600">
            <CalendarClock className="size-3" />
            Updated {formatRelative(overview.generatedAt)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Snap({
  label,
  value,
  hint,
  href,
  hot,
}: {
  label: string;
  value: number;
  hint: string;
  href: string;
  hot?: boolean;
}) {
  return (
    <Link
      href={href}
      className="bg-neutral-950/80 px-4 py-3.5 transition hover:bg-neutral-900"
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums tracking-tight",
          hot ? "text-white" : "text-neutral-400",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-neutral-600">{hint}</p>
    </Link>
  );
}

function MotionRail({
  motion,
  description,
  items,
}: {
  motion: string;
  description: string;
  items: {
    href: string;
    icon: typeof KanbanSquare;
    title: string;
    stat: string;
    alert?: string | null;
  }[];
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-neutral-950/50 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {motion}
        </p>
        <p className="text-[11px] text-neutral-600">{description}</p>
      </div>
      <div className="space-y-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition hover:bg-white/[0.04]"
            >
              <Icon className="size-3.5 shrink-0 text-neutral-500" />
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                {item.title}
              </span>
              {item.alert ? (
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  {item.alert}
                </span>
              ) : (
                <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                  {item.stat}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function StreamPanel({
  href,
  title,
  empty,
  children,
}: {
  href: string;
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-neutral-950/40">
      <div className="flex items-center justify-between border-b border-white/[0.04] px-3 py-2">
        <p className="text-xs font-semibold text-neutral-300">{title}</p>
        <Link
          href={href}
          className="text-[11px] text-neutral-500 transition hover:text-neutral-300"
        >
          Open
        </Link>
      </div>
      {empty ? (
        <p className="px-3 py-6 text-center text-xs text-neutral-600">
          Nothing here
        </p>
      ) : (
        <div className="divide-y divide-white/[0.04] px-1 py-1">{children}</div>
      )}
    </div>
  );
}

function StreamRow({
  label,
  tag,
  danger,
}: {
  label: string;
  tag: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
      <span className="min-w-0 truncate text-neutral-400">{label}</span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 capitalize",
          danger
            ? "bg-amber-500/15 text-amber-300"
            : "bg-white/[0.05] text-neutral-500",
        )}
      >
        {tag}
      </span>
    </div>
  );
}
