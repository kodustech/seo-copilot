"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  KanbanSquare,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Target,
  XCircle,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import type { AttentionItem, UserOverview } from "@/lib/user-center";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------

const SEVERITY_STYLES: Record<
  AttentionItem["severity"],
  { className: string; icon: typeof AlertTriangle }
> = {
  error: { className: "border-red-500/30 bg-red-500/[0.07]", icon: XCircle },
  warning: {
    className: "border-amber-500/30 bg-amber-500/[0.07]",
    icon: AlertTriangle,
  },
  info: { className: "border-sky-500/25 bg-sky-500/[0.06]", icon: Clock },
};

const SOURCE_ICON: Record<string, typeof KanbanSquare> = {
  kanban: KanbanSquare,
  crm: Building2,
  outreach: Send,
  goals: Target,
  jobs: Clock,
  reply_radar: MessageCircle,
};

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "—";
  if (days < 0) return `em ${-days}d`;
  if (days === 0) return "hoje";
  if (days === 1) return "1d atrás";
  if (days < 30) return `${days}d atrás`;
  return `${Math.floor(days / 30)}mo atrás`;
}

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const firstName = overview?.userEmail?.split("@")[0]?.split(".")[0] ?? "";

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Central de Controle
          </h2>
          <p className="text-sm capitalize text-neutral-500">
            {firstName ? `Oi, ${firstName} — ` : ""}
            <span className="lowercase">tudo que está no seu nome, num lugar só.</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => load()}
          className="h-8 gap-1.5 text-neutral-400 hover:text-white"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Atualizar
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !overview ? (
        <Loader2 className="mx-auto mt-16 size-6 animate-spin text-neutral-500" />
      ) : overview ? (
        <>
          {/* Attention feed */}
          <section className="mb-6">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-neutral-300">
              <AlertTriangle className="size-4 text-amber-400" />
              Precisa de atenção
              <span className="rounded bg-white/10 px-1.5 text-xs text-neutral-400">
                {overview.attention.length}
              </span>
            </h3>
            {overview.attention.length === 0 ? (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-4 text-sm text-emerald-300">
                <CheckCircle2 className="size-4" /> Tudo em dia. Nenhuma pendência
                no seu nome. 🎉
              </div>
            ) : (
              <div className="space-y-2">
                {overview.attention.map((a) => {
                  const sev = SEVERITY_STYLES[a.severity];
                  const SevIcon = sev.icon;
                  return (
                    <Link
                      key={a.dedupeKey}
                      href={a.link}
                      className={cn(
                        "group flex items-center gap-3 rounded-xl border px-4 py-3 transition hover:brightness-125",
                        sev.className,
                      )}
                    >
                      <SevIcon
                        className={cn(
                          "size-4 shrink-0",
                          a.severity === "error"
                            ? "text-red-400"
                            : a.severity === "warning"
                              ? "text-amber-400"
                              : "text-sky-400",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-neutral-100">
                          {a.title}
                        </p>
                        {a.body && (
                          <p className="truncate text-xs text-neutral-400">
                            {a.body}
                          </p>
                        )}
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-neutral-500 group-hover:text-neutral-300" />
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {/* Source cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SourceCard
              href="/kanban"
              icon={KanbanSquare}
              title="Kanban"
              primary={`${overview.kanban.pending} cards`}
              alert={overview.kanban.overdue > 0 ? `${overview.kanban.overdue} atrasados` : null}
            >
              {overview.kanban.items.slice(0, 4).map((i) => (
                <Row key={i.id} label={i.title} tag={i.stage} danger={i.overdue} />
              ))}
            </SourceCard>

            <SourceCard
              href="/crm"
              icon={Building2}
              title="CRM"
              primary={`${overview.crm.total} contas`}
              alert={overview.crm.idle > 0 ? `${overview.crm.idle} paradas` : null}
            >
              {overview.crm.companies.slice(0, 4).map((c) => (
                <Row
                  key={c.id}
                  label={c.name}
                  tag={c.status}
                  danger={c.isStale}
                />
              ))}
            </SourceCard>

            <SourceCard
              href="/outreach"
              icon={Send}
              title="Outreach"
              primary={`${overview.outreach.total} prospects`}
              alert={
                overview.outreach.followupDue > 0
                  ? `${overview.outreach.followupDue} follow-ups`
                  : null
              }
            >
              {overview.outreach.prospects.slice(0, 4).map((p) => (
                <Row key={p.id} label={p.domain} tag={p.status} danger={p.due} />
              ))}
            </SourceCard>

            <SourceCard
              href="/goals"
              icon={Target}
              title="Metas"
              primary={`${overview.goals.total} ativas`}
              alert={overview.goals.atRisk > 0 ? `${overview.goals.atRisk} em risco` : null}
            >
              {overview.goals.items.slice(0, 4).map((g) => (
                <Row
                  key={g.id}
                  label={g.title}
                  tag={`${Math.round(g.progress * 100)}%`}
                  danger={g.atRisk}
                />
              ))}
            </SourceCard>

            <SourceCard
              href="/jobs"
              icon={Clock}
              title="Jobs agendados"
              primary={`${overview.jobs.total} jobs`}
              alert={overview.jobs.failing > 0 ? `${overview.jobs.failing} falhando` : null}
            >
              {overview.jobs.items.slice(0, 4).map((j) => (
                <Row
                  key={j.id}
                  label={j.name}
                  tag={j.enabled ? (j.lastStatus ?? "—") : "off"}
                  danger={j.lastStatus === "failed"}
                />
              ))}
            </SourceCard>

            <SourceCard
              href="/reply-radar"
              icon={MessageCircle}
              title="Reply Radar"
              primary={`${overview.replyRadar.pending} pendentes`}
              alert={overview.replyRadar.pending > 0 ? "aguardando" : null}
            />
          </div>

          <p className="mt-4 flex items-center gap-1.5 text-xs text-neutral-600">
            <CalendarClock className="size-3" />
            Atualizado {formatRelative(overview.generatedAt)}
          </p>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SourceCard({
  href,
  icon: Icon,
  title,
  primary,
  alert,
  children,
}: {
  href: string;
  icon: typeof KanbanSquare;
  title: string;
  primary: string;
  alert: string | null;
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-xl border border-white/[0.06] bg-neutral-900/50 p-4 transition hover:border-white/15 hover:bg-neutral-900"
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon className="size-4 text-violet-300" />
        <span className="text-sm font-medium text-neutral-200">{title}</span>
        {alert && (
          <Badge className="ml-auto border-0 bg-amber-500/20 text-[10px] font-normal text-amber-300">
            {alert}
          </Badge>
        )}
      </div>
      <p className="text-lg font-semibold text-white">{primary}</p>
      {children && <div className="mt-2 space-y-1">{children}</div>}
    </Link>
  );
}

function Row({
  label,
  tag,
  danger,
}: {
  label: string;
  tag: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate text-neutral-400">{label}</span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 capitalize",
          danger
            ? "bg-amber-500/15 text-amber-300"
            : "bg-white/[0.06] text-neutral-500",
        )}
      >
        {tag}
      </span>
    </div>
  );
}
