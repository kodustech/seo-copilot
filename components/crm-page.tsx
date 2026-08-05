"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
  Activity,
  Mail,
  MessageSquare,
  Users,
  Zap,
  ExternalLink,
} from "lucide-react";

import { CrmBoard, boardColumns, type BoardGroupBy } from "@/components/crm-board";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import {
  COMPANY_PRIORITIES,
  COMPANY_STATUSES,
  type CompanyPrep,
  type CompanyPriority,
  type CompanyStatus,
  type CompanyWithIdle,
  type CrmActivity,
  type CrmComment,
  type CrmContact,
} from "@/lib/crm";
import {
  CRM_FIELD_TYPES,
  type CrmFieldDef,
  type CrmFieldOption,
  type CrmFieldType,
  type CrmPropertyValue,
} from "@/lib/crm-fields";
import type { ProductSignals } from "@/lib/crm-signals";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownContent } from "@/components/markdown-content";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// ---------------------------------------------------------------------------
// Labels + colors
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<CompanyStatus, { label: string; className: string }> = {
  lead: { label: "Lead", className: "bg-neutral-500/20 text-neutral-300" },
  engaged: { label: "Engaged", className: "bg-cyan-500/20 text-cyan-300" },
  qualified: { label: "Qualified", className: "bg-sky-500/20 text-sky-300" },
  poc: { label: "POC", className: "bg-amber-500/20 text-amber-300" },
  negotiation: { label: "Negotiation", className: "bg-violet-500/20 text-violet-300" },
  customer: { label: "Customer", className: "bg-emerald-500/20 text-emerald-300" },
  churned: { label: "Churned", className: "bg-red-500/20 text-red-300" },
  lost: { label: "Lost", className: "bg-neutral-700/40 text-neutral-500" },
};

// Outbound tier from product signals (machine-owned, read-only in the UI).
const TIER_LABELS: Record<string, { label: string; className: string; hint: string }> = {
  t0: {
    label: "t0",
    className: "bg-red-500/20 text-red-300",
    hint: "Open decision window: trial or free limit",
  },
  t1: {
    label: "t1",
    className: "bg-sky-500/20 text-sky-300",
    hint: "Connected git recently",
  },
  t2: {
    label: "t2",
    className: "bg-amber-500/15 text-amber-300",
    hint: "Signed up, never connected",
  },
  t3: {
    label: "t3",
    className: "bg-neutral-500/15 text-neutral-400",
    hint: "Older base",
  },
  customer: {
    label: "cust",
    className: "bg-emerald-500/15 text-emerald-300",
    hint: "Paying — excluded from outbound",
  },
};
const TIER_OPTIONS = ["t0", "t1", "t2", "t3", "customer"] as const;

// Preparation state — a different axis from status. Status says where the
// relationship stands; this says whether the account has been vetted enough to
// be worked at all. Only `ready` can enter a sequence.
const PREP_LABELS: Record<
  CompanyPrep,
  { label: string; className: string; hint: string }
> = {
  not_started: {
    label: "Not started",
    className: "bg-neutral-700/40 text-neutral-400",
    hint: "Nothing done yet — not enriched, not contacted, not in a sequence",
  },
  enriched: {
    label: "Enriched",
    className: "bg-indigo-500/20 text-indigo-300",
    hint: "Lookup ran. Waiting on you to vet it",
  },
  ready: {
    label: "Ready",
    className: "bg-emerald-500/20 text-emerald-300",
    hint: "Vetted — can be enrolled in a sequence",
  },
  parked: {
    label: "Parked",
    className: "bg-neutral-800/60 text-neutral-500",
    hint: "Vetted and set aside — not worth working",
  },
};
const PREP_OPTIONS: CompanyPrep[] = ["not_started", "enriched", "ready", "parked"];

/** PREP_LABELS lookup that cannot return undefined.
 *
 *  rowToCompany passes a prep_status through even when this build does not know
 *  it, so that a state added to the database ahead of the UI stays visible
 *  rather than masquerading as 'not_started'. The cost of that honesty is that
 *  every render site here has to survive a value with no entry — without this,
 *  one unrecognised row takes the whole accounts page down with a TypeError. */
function prepLabel(p: string): { label: string; className: string; hint: string } {
  return (
    PREP_LABELS[p as CompanyPrep] ?? {
      label: p,
      className: "bg-red-500/15 text-red-300",
      hint: "Prep state not recognised by this build",
    }
  );
}

/**
 * "Have I written to this account, and when?"
 *
 * Its own column rather than a reading of Last activity, because Last activity
 * moves on every signal sweep — of the 500 most recent activities, 342 are
 * sweep signals. An account contacted last week and one never touched show the
 * same Last activity, which is precisely why this was unanswerable before.
 *
 * "Never" is deliberately not an em dash: an empty cell reads as missing data,
 * and this one is a fact.
 */
function OutreachCell({
  count,
  lastAt,
}: {
  count: number;
  lastAt: string | null;
}) {
  if (!count || !lastAt) {
    return <span className="text-sm text-neutral-600">Never</span>;
  }
  const days = Math.floor(
    (Date.now() - new Date(lastAt).getTime()) / 86_400_000,
  );
  const when = days <= 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
  return (
    <span className="whitespace-nowrap text-sm text-neutral-300">
      {count} sent <span className="text-neutral-500">· {when}</span>
    </span>
  );
}

// Where the account came from (crm_companies.source), shown as "Channel".
const CHANNEL_LABELS: Record<string, string> = {
  product: "Product signup",
  sequence: "Outbound",
  research: "Research",
  social: "Social",
  pipeline: "Pipeline import",
  webhook: "Webhook",
  agent: "Agent",
  manual: "Manual",
};
const CHANNEL_OPTIONS = [
  "product",
  "sequence",
  "research",
  "social",
  "pipeline",
  "webhook",
  "agent",
  "manual",
] as const;

const DEPLOYMENT_LABELS: Record<string, { label: string; className: string }> = {
  cloud: { label: "cloud", className: "bg-sky-500/15 text-sky-300" },
  self_hosted: { label: "self-hosted", className: "bg-violet-500/15 text-violet-300" },
};

const PRIORITY_BADGE: Record<CompanyPriority, string> = {
  high: "bg-red-500/15 text-red-300",
  medium: "bg-sky-500/15 text-sky-300",
  low: "bg-neutral-500/15 text-neutral-400",
};

const HEALTH_LABELS: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-emerald-500/20 text-emerald-300" },
  cooling: { label: "Cooling", className: "bg-amber-500/20 text-amber-300" },
  at_risk: { label: "At risk", className: "bg-orange-500/20 text-orange-300" },
  dormant: { label: "Dormant", className: "bg-red-500/20 text-red-300" },
  unknown: { label: "Unknown", className: "bg-neutral-500/20 text-neutral-400" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TeamMember = { email: string; label: string };

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "—";
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Trial end is the only date in this UI that points forward, and formatRelative
 * only speaks about the past: a future date makes `days` negative, lands on the
 * `days <= 0` branch and renders as "today". Every live trial therefore looked
 * like it was expiring right now — including one running to 2030.
 *
 * Compares calendar days, not elapsed milliseconds, so a trial ending tonight
 * reads "today" instead of "tomorrow".
 */
function formatDeadline(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "—";
  const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(at) - midnight(Date.now())) / 86_400_000);
  if (days > 1) return `in ${days}d`;
  if (days === 1) return "tomorrow";
  if (days === 0) return "today";
  if (days === -1) return "expired yesterday";
  return `expired ${-days}d ago`;
}

/**
 * "18/121 (15%) · 10 partial" — three deliberate choices.
 *
 * The denominator stays visible: a bare percentage hides the difference between
 * 1-of-2 and 300-of-600, and the first is noise. Partial counts toward the rate
 * (a developer who took half the suggestion still acted on it) but is also
 * called out, because partial can outnumber full and the two are not the same
 * story to tell a customer. And with nothing delivered there is no rate at all,
 * which is not the same as 0%.
 */
function formatImplementationRate(
  implemented: number | null,
  partial: number | null,
  total: number | null,
): string {
  if (total == null || implemented == null) return "—";
  if (total === 0) return "no suggestions";
  const applied = implemented + (partial ?? 0);
  const pct = Math.round((applied / total) * 100);
  const suffix = partial ? ` · ${partial} partial` : "";
  return `${applied}/${total} (${pct}%)${suffix}`;
}

function ownerLabel(email: string | null, members: TeamMember[]): string {
  if (!email) return "—";
  const m = members.find((x) => x.email === email);
  return m?.label ?? email.split("@")[0];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CrmPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [companies, setCompanies] = useState<CompanyWithIdle[]>([]);
  const [stats, setStats] = useState<{
    total: number;
    byStatus: Record<string, number>;
    stale: number;
  }>({ total: 0, byStatus: {}, stale: 0 });
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<CompanyStatus | "all">("all");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [prepFilter, setPrepFilter] = useState<string>("all");
  const [view, setView] = useState<"list" | "board">("list");
  // Defaults to prep because that is the work that exists: 85 of 107 accounts
  // sit in `lead`, so a status board is one tall column and seven empty ones.
  const [groupBy, setGroupBy] = useState<BoardGroupBy>("prep");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [deploymentFilter, setDeploymentFilter] = useState<string>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [staleOnly, setStaleOnly] = useState(false);
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [fieldDefs, setFieldDefs] = useState<CrmFieldDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importingPipeline, setImportingPipeline] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  // ── auth token ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, session) => {
      setToken(session?.access_token ?? null);
    });
    return () => subscription.unsubscribe();
  }, [supabase]);

  const authFetch = useCallback(
    (url: string, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }),
    [token],
  );

  const loadFields = useCallback(async () => {
    if (!token) return;
    try {
      const res = await authFetch("/api/crm/fields");
      const json = await res.json();
      if (!res.ok) {
        console.error("[crm] load fields failed:", json.error);
        setError(
          typeof json.error === "string"
            ? `Custom fields: ${json.error}`
            : "Failed to load custom fields",
        );
        return;
      }
      setFieldDefs(json.fields ?? []);
    } catch (err) {
      console.error("[crm] load fields failed:", err);
    }
  }, [token, authFetch]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (tierFilter !== "all") params.set("tier", tierFilter);
      // "todo" is the review queue: the two states nobody has judged yet.
      if (prepFilter === "todo") params.set("prepStatus", "not_started,enriched");
      else if (prepFilter !== "all") params.set("prepStatus", prepFilter);
      if (channelFilter !== "all") params.set("source", channelFilter);
      if (deploymentFilter !== "all") params.set("deployment", deploymentFilter);
      if (ownerFilter !== "all") params.set("ownerEmail", ownerFilter);
      if (staleOnly) params.set("staleOnly", "true");
      if (search.trim()) params.set("search", search.trim());
      const res = await authFetch(`/api/crm/companies?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load");
      setCompanies(json.companies ?? []);
      setStats(json.stats ?? { total: 0, byStatus: {}, stale: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter, tierFilter, prepFilter, channelFilter, deploymentFilter, ownerFilter, staleOnly, search, authFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadFields();
  }, [loadFields]);

  // team members for owner pickers
  useEffect(() => {
    if (!token) return;
    authFetch("/api/team/members")
      .then((r) => r.json())
      .then((j) => setMembers(j.members ?? []))
      .catch(() => undefined);
  }, [token, authFetch]);

  async function patchCompany(id: string, patch: Record<string, unknown>) {
    // optimistic
    setCompanies((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
    const res = await authFetch(`/api/crm/companies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!res.ok) void load();
    else void load();
  }

  async function removeCompany(id: string) {
    if (!confirm("Delete this company and all its data?")) return;
    setCompanies((prev) => prev.filter((c) => c.id !== id));
    await authFetch(`/api/crm/companies/${id}`, { method: "DELETE" });
    void load();
  }

  async function importPipeline() {
    if (
      !confirm(
        "Import legacy Pipeline prospects into Accounts? Companies match by domain; existing accounts are updated, not duplicated.",
      )
    ) {
      return;
    }
    setImportingPipeline(true);
    setImportNotice(null);
    setError(null);
    try {
      const res = await authFetch("/api/crm/import-pipeline", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      setImportNotice(json.message ?? "Import complete");
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportingPipeline(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Building2 className="size-5 text-violet-300" /> Accounts
          </h2>
          <p className="max-w-xl text-sm text-pretty text-neutral-500">
            System of record for Convert — companies, contacts, and stage.
            Discover in{" "}
            <a href="/research" className="text-neutral-300 underline-offset-2 hover:underline">
              ICP lists
            </a>
            , run{" "}
            <a href="/sequences" className="text-neutral-300 underline-offset-2 hover:underline">
              Outbound
            </a>
            , manage here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFieldsOpen(true)}
            className="h-8 gap-1.5 border-white/10 text-neutral-300"
          >
            <Settings2 className="size-3.5" />
            Manage fields
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={importingPipeline}
            onClick={() => void importPipeline()}
            className="h-8 gap-1.5 border-white/10 text-neutral-300"
          >
            {importingPipeline ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Zap className="size-3.5" />
            )}
            Import pipeline
          </Button>
          <WebhookDocs />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => load()}
            className="h-8 gap-1.5 text-neutral-400 hover:text-white"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="h-8 gap-1.5 bg-white text-neutral-900 hover:bg-neutral-200"
          >
            <Plus className="size-3.5" /> New account
          </Button>
        </div>
      </div>

      {importNotice && (
        <div className="mb-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          {importNotice}
        </div>
      )}

      {/* Stat tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Accounts" value={stats.total} />
        <StatTile label="Customers" value={stats.byStatus.customer ?? 0} accent="emerald" />
        <StatTile
          label="Open stage"
          value={
            (stats.byStatus.lead ?? 0) +
            (stats.byStatus.engaged ?? 0) +
            (stats.byStatus.qualified ?? 0) +
            (stats.byStatus.poc ?? 0) +
            (stats.byStatus.negotiation ?? 0)
          }
          accent="sky"
        />
        <button onClick={() => setStaleOnly((v) => !v)} className="text-left">
          <StatTile
            label="Idle (needs attention)"
            value={stats.stale}
            accent="amber"
            active={staleOnly}
          />
        </button>
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-neutral-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, domain, org id…"
            className="h-8 w-64 border-white/10 bg-neutral-900 pl-8 text-sm"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as CompanyStatus | "all")}
        >
          <SelectTrigger className="h-8 w-36 border-white/10 bg-neutral-900 text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {COMPANY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tierFilter} onValueChange={setTierFilter}>
          <SelectTrigger className="h-8 w-32 border-white/10 bg-neutral-900 text-sm">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            {TIER_OPTIONS.map((t) => (
              <SelectItem key={t} value={t}>
                {TIER_LABELS[t].label} — {TIER_LABELS[t].hint}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* View switch, and — on the board — what the columns are.
            The grouping question has no permanent right answer: the board that
            matters today is the work queue (prep), and the one that matters
            once deals move is the pipeline (status). */}
        <div className="flex items-center rounded-md border border-white/10 bg-neutral-900">
          {(["list", "board"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "h-8 px-3 text-sm capitalize transition-colors",
                view === v
                  ? "text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        {view === "board" ? (
          <Select
            value={groupBy}
            onValueChange={(v) => setGroupBy(v as BoardGroupBy)}
          >
            <SelectTrigger className="h-8 w-44 border-white/10 bg-neutral-900 text-sm">
              <SelectValue placeholder="Group by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prep">Group by prep — the work</SelectItem>
              <SelectItem value="status">Group by status — the deal</SelectItem>
              <SelectItem value="tier">Group by tier — read-only</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <Select value={prepFilter} onValueChange={setPrepFilter}>
          <SelectTrigger className="h-8 w-40 border-white/10 bg-neutral-900 text-sm">
            <SelectValue placeholder="Prep" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All prep states</SelectItem>
            {/* The review queue, as one click: everything the machine has
                processed and a human has not yet judged. */}
            <SelectItem value="todo">To review (not started + enriched)</SelectItem>
            {PREP_OPTIONS.map((p) => (
              <SelectItem key={p} value={p}>
                {PREP_LABELS[p].label} — {PREP_LABELS[p].hint}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="h-8 w-36 border-white/10 bg-neutral-900 text-sm">
            <SelectValue placeholder="Channel" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {CHANNEL_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {CHANNEL_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={deploymentFilter} onValueChange={setDeploymentFilter}>
          <SelectTrigger className="h-8 w-32 border-white/10 bg-neutral-900 text-sm">
            <SelectValue placeholder="Deployment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Cloud + self-hosted</SelectItem>
            <SelectItem value="cloud">Cloud</SelectItem>
            <SelectItem value="self_hosted">Self-hosted</SelectItem>
          </SelectContent>
        </Select>
        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="h-8 w-40 border-white/10 bg-neutral-900 text-sm">
            <SelectValue placeholder="Owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.email} value={m.email}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {staleOnly && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStaleOnly(false)}
            className="h-8 gap-1 text-amber-300"
          >
            <AlertTriangle className="size-3.5" /> Idle only <X className="size-3" />
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {view === "board" ? (
        <CrmBoard
          companies={companies}
          groupBy={groupBy}
          columns={boardColumns(groupBy, {
            prep: PREP_LABELS,
            status: STATUS_LABELS,
            tier: TIER_LABELS,
          })}
          // Tier is machine-owned: the sweep derives it from product behaviour,
          // so a card dragged between tier columns would be asserting something
          // the next sweep overwrites within four hours. Read-only instead of
          // silently reverting.
          onMove={
            groupBy === "tier"
              ? null
              : (id, patch) => void patchCompany(id, patch)
          }
          onOpen={(c) => setSelectedId(c.id)}
          renderCardMeta={(c) => (
            <>
              {c.tier && TIER_LABELS[c.tier] ? (
                <Badge
                  title={TIER_LABELS[c.tier].hint}
                  className={cn(
                    "border-0 text-[11px] font-normal",
                    TIER_LABELS[c.tier].className,
                  )}
                >
                  {TIER_LABELS[c.tier].label}
                </Badge>
              ) : null}
              {c.devCount ? (
                <span className="text-[11px] text-neutral-500">
                  {c.devCount} devs
                </span>
              ) : null}
              <span className="text-[11px] text-neutral-600">
                {c.outreachSentCount > 0
                  ? `${c.outreachSentCount} sent`
                  : "never contacted"}
              </span>
            </>
          )}
        />
      ) : (
      /* Table */
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <Table>
          <TableHeader>
            <TableRow className="border-white/[0.06] hover:bg-transparent">
              <TableHead className="text-neutral-500">Company</TableHead>
              <TableHead className="text-neutral-500">Status</TableHead>
              <TableHead className="text-neutral-500">Tier</TableHead>
              <TableHead className="text-neutral-500">Prep</TableHead>
              <TableHead className="text-neutral-500">Outreach</TableHead>
              <TableHead className="text-neutral-500">Priority</TableHead>
              <TableHead className="text-neutral-500">Owner</TableHead>
              <TableHead className="text-neutral-500">Last activity</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && companies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-neutral-500">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : companies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-neutral-500">
                  No accounts yet. Push from ICP lists, import the old pipeline,
                  or create one.
                </TableCell>
              </TableRow>
            ) : (
              companies.map((c) => (
                <TableRow
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className="cursor-pointer border-white/[0.06] hover:bg-white/[0.02]"
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5 font-medium text-neutral-100">
                          {c.name}
                          {c.isStale && (
                            <AlertTriangle className="size-3.5 text-amber-400" />
                          )}
                        </span>
                        <span className="truncate text-xs text-neutral-500">
                          {c.domain ?? "—"}
                          {c.devCount != null && (
                            <span className="ml-1.5 rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-neutral-400">
                              {c.devCount} devs
                            </span>
                          )}
                          {c.orgId && (
                            <span className="ml-1.5 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] text-violet-300">
                              linked
                            </span>
                          )}
                          {c.deployment && DEPLOYMENT_LABELS[c.deployment] && (
                            <span
                              className={cn(
                                "ml-1.5 rounded px-1 py-0.5 text-[10px]",
                                DEPLOYMENT_LABELS[c.deployment].className,
                              )}
                            >
                              {DEPLOYMENT_LABELS[c.deployment].label}
                            </span>
                          )}
                          {c.source && CHANNEL_LABELS[c.source] && (
                            <span className="ml-1.5 rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-neutral-400">
                              {CHANNEL_LABELS[c.source]}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Select
                      value={c.status}
                      onValueChange={(v) => patchCompany(c.id, { status: v })}
                    >
                      <SelectTrigger className="h-7 w-32 border-0 bg-transparent px-1.5 text-xs">
                        <Badge
                          className={cn(
                            "border-0 font-normal",
                            STATUS_LABELS[c.status].className,
                          )}
                        >
                          {STATUS_LABELS[c.status].label}
                        </Badge>
                      </SelectTrigger>
                      <SelectContent>
                        {COMPANY_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {STATUS_LABELS[s].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {c.tier && TIER_LABELS[c.tier] ? (
                      <Badge
                        title={TIER_LABELS[c.tier].hint}
                        className={cn(
                          "border-0 font-normal",
                          TIER_LABELS[c.tier].className,
                        )}
                      >
                        {TIER_LABELS[c.tier].label}
                      </Badge>
                    ) : (
                      <span className="text-sm text-neutral-600">—</span>
                    )}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {/* Editable inline: vetting happens while scanning the
                        list, not only inside the drawer. */}
                    <Select
                      value={c.prepStatus}
                      onValueChange={(v) => patchCompany(c.id, { prepStatus: v })}
                    >
                      <SelectTrigger className="h-7 w-28 border-0 bg-transparent px-1.5 text-xs">
                        <Badge
                          title={prepLabel(c.prepStatus).hint}
                          className={cn(
                            "border-0 font-normal",
                            prepLabel(c.prepStatus).className,
                          )}
                        >
                          {prepLabel(c.prepStatus).label}
                        </Badge>
                      </SelectTrigger>
                      <SelectContent>
                        {PREP_OPTIONS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {PREP_LABELS[p].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <OutreachCell
                      count={c.outreachSentCount}
                      lastAt={c.lastOutreachAt}
                    />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Select
                      value={c.priority}
                      onValueChange={(v) => patchCompany(c.id, { priority: v })}
                    >
                      <SelectTrigger className="h-7 w-24 border-0 bg-transparent px-1.5 text-xs">
                        <Badge
                          className={cn(
                            "border-0 font-normal capitalize",
                            PRIORITY_BADGE[c.priority],
                          )}
                        >
                          {c.priority}
                        </Badge>
                      </SelectTrigger>
                      <SelectContent>
                        {COMPANY_PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p} className="capitalize">
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-sm text-neutral-400">
                    {ownerLabel(c.ownerEmail, members)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "text-sm",
                        c.isStale ? "text-amber-300" : "text-neutral-400",
                      )}
                    >
                      {formatRelative(c.lastActivityAt)}
                      {c.isStale && c.slaDays != null && (
                        <span className="ml-1 text-[10px] text-amber-500/70">
                          (SLA {c.slaDays}d)
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => removeCompany(c.id)}
                      className="text-neutral-600 transition hover:text-red-400"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      )}

      {createOpen && (
        <CreateCompanyDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          members={members}
          authFetch={authFetch}
          onCreated={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      )}

      {fieldsOpen && (
        <ManageFieldsDialog
          open={fieldsOpen}
          fields={fieldDefs}
          authFetch={authFetch}
          onClose={() => setFieldsOpen(false)}
          onChanged={() => loadFields()}
        />
      )}

      {selectedId && (
        <CompanyDrawer
          companyId={selectedId}
          members={members}
          fieldDefs={fieldDefs}
          authFetch={authFetch}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  accent,
  active,
}: {
  label: string;
  value: number;
  accent?: "emerald" | "sky" | "amber";
  active?: boolean;
}) {
  const accentClass =
    accent === "emerald"
      ? "text-emerald-300"
      : accent === "sky"
        ? "text-sky-300"
        : accent === "amber"
          ? "text-amber-300"
          : "text-white";
  return (
    <div
      className={cn(
        "rounded-xl border border-white/[0.06] bg-neutral-900/50 px-4 py-3 transition",
        active && "border-amber-500/40 bg-amber-500/[0.06]",
      )}
    >
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p className={cn("mt-0.5 text-2xl font-semibold", accentClass)}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhook docs popover
// ---------------------------------------------------------------------------

function WebhookDocs() {
  const example = `curl -X POST \\
  "$APP_URL/api/crm/webhook" \\
  -H "Authorization: Bearer $CRM_WEBHOOK_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Acme Inc",
    "domain": "acme.com",
    "orgId": "org-uuid-optional",
    "industry": "SaaS",
    "size": "50-200",
    "devCount": 120,
    "country": "BR",
    "tags": ["inbound"],
    "enrichment": { "employees": 120, "stack": ["node"] }
  }'`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-neutral-400 hover:text-white"
        >
          <Zap className="size-3.5" /> Webhook
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[440px] border-white/10 bg-neutral-950 text-neutral-200"
      >
        <p className="mb-1 text-sm font-medium text-white">Enrichment webhook</p>
        <p className="mb-2 text-xs text-neutral-400">
          Idempotent upsert by <code className="text-violet-300">orgId</code>, then{" "}
          <code className="text-violet-300">domain</code>. Auth with{" "}
          <code className="text-violet-300">CRM_WEBHOOK_SECRET</code>.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-black/50 p-3 text-[11px] leading-relaxed text-neutral-300">
          {example}
        </pre>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateCompanyDialog({
  open,
  onClose,
  members,
  authFetch,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  members: TeamMember[];
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [orgId, setOrgId] = useState("");
  const [status, setStatus] = useState<CompanyStatus>("lead");
  const [priority, setPriority] = useState<CompanyPriority>("medium");
  const [ownerEmail, setOwnerEmail] = useState<string>("");
  const [devCount, setDevCount] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    setSaving(true);
    setErr(null);
    const res = await authFetch("/api/crm/companies", {
      method: "POST",
      body: JSON.stringify({
        name,
        domain: domain || null,
        orgId: orgId || null,
        status,
        priority,
        ownerEmail: ownerEmail || null,
        devCount: devCount.trim() ? Number(devCount) : null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Failed to create");
      return;
    }
    onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-white/10 bg-neutral-950 text-neutral-100">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name *">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="border-white/10 bg-neutral-900" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Domain">
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" className="border-white/10 bg-neutral-900" />
            </Field>
            <Field label="Product org">
              <OrgPicker value={orgId} onCommit={(v) => setOrgId(v ?? "")} authFetch={authFetch} />
            </Field>
          </div>
          <Field label="Team size (devs)">
            <Input
              type="number"
              min={0}
              value={devCount}
              onChange={(e) => setDevCount(e.target.value)}
              placeholder="ex: 40 — engineering headcount, not Kodus seats"
              className="border-white/10 bg-neutral-900"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Status">
              <Select value={status} onValueChange={(v) => setStatus(v as CompanyStatus)}>
                <SelectTrigger className="border-white/10 bg-neutral-900"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABELS[s].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={priority} onValueChange={(v) => setPriority(v as CompanyPriority)}>
                <SelectTrigger className="border-white/10 bg-neutral-900"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Owner">
              <Select value={ownerEmail || "none"} onValueChange={(v) => setOwnerEmail(v === "none" ? "" : v)}>
                <SelectTrigger className="border-white/10 bg-neutral-900"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.email} value={m.email}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {err && <p className="text-sm text-red-400">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-white text-neutral-900 hover:bg-neutral-200">
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

// ── Product org autocomplete ──────────────────────────────────────────────
// Search product orgs by name (backed by product_signals_latest) so nobody
// has to hunt uuids. Typing a raw uuid still works: blur commits free text.

type OrgSuggestion = {
  orgId: string;
  name: string | null;
  userCount: number | null;
  planType: string | null;
  tier: string | null;
};

function OrgPicker({
  value,
  onCommit,
  authFetch,
}: {
  value: string;
  onCommit: (orgId: string | null) => void;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [text, setText] = useState(value);
  const [results, setResults] = useState<OrgSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Sync from a parent-provided value during render (React "adjusting state
  // when props change" pattern — avoids a cascading-render effect).
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setText(value);
  }

  const query = text.trim();
  const searchable = query.length >= 2 && query !== value;

  useEffect(() => {
    if (!searchable) {
      setResults([]);
      setNote(null);
      setOpen(false);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await authFetch(
          `/api/crm/org-search?q=${encodeURIComponent(query)}`,
        );
        const data = (await res.json()) as {
          orgs?: OrgSuggestion[];
          note?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setResults([]);
          setNote(data.error || "Search failed");
          setOpen(true);
          return;
        }
        const orgs = data.orgs ?? [];
        setResults(orgs);
        setNote(orgs.length === 0 ? data.note || "No matching product org" : null);
        setOpen(true);
      } catch {
        if (cancelled) return;
        setResults([]);
        setNote("Search failed");
        setOpen(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searchable, authFetch]);

  return (
    <div className="relative">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          if (searchable && (results.length > 0 || note)) setOpen(true);
        }}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
          const t = text.trim();
          if (t !== (value ?? "")) onCommit(t || null);
        }}
        placeholder="Search org by name, or paste a uuid"
        className="border-white/10 bg-neutral-900 text-xs"
        autoComplete="off"
      />
      {searching && (
        <p className="mt-1 text-[11px] text-neutral-500">Searching…</p>
      )}
      {open && searchable && !searching && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-white/10 bg-neutral-900 shadow-xl">
          {results.length === 0 ? (
            <p className="px-2.5 py-2 text-[11px] text-neutral-500">
              {note || "No matching product org"}
            </p>
          ) : (
            results.map((r) => (
              <button
                key={r.orgId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(r.orgId);
                  setOpen(false);
                  onCommit(r.orgId);
                }}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-white/[0.06]"
              >
                <span className="min-w-0 truncate text-neutral-200">
                  <span className="font-medium">{r.name ?? r.orgId}</span>
                  {r.name && (
                    <span className="ml-1.5 font-mono text-[10px] text-neutral-500">
                      {r.orgId.slice(0, 8)}…
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] text-neutral-500">
                  {[
                    r.userCount != null ? `${r.userCount} users` : null,
                    r.planType,
                    r.tier,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {!searchable && !value && (
        <p className="mt-1 text-[11px] text-neutral-500">
          Type at least 2 characters to search product orgs.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Company drawer
// ---------------------------------------------------------------------------

type DrawerTab =
  | "overview"
  | "emails"
  | "comments"
  | "contacts"
  | "timeline"
  | "signals";

function CompanyDrawer({
  companyId,
  members,
  fieldDefs,
  authFetch,
  onClose,
  onChanged,
}: {
  companyId: string;
  members: TeamMember[];
  fieldDefs: CrmFieldDef[];
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [company, setCompany] = useState<CompanyWithIdle | null>(null);
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [comments, setComments] = useState<CrmComment[]>([]);
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DrawerTab>("overview");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(`/api/crm/companies/${companyId}`);
    const j = await res.json();
    if (res.ok) {
      setCompany(j.company);
      setContacts(j.contacts ?? []);
      setComments(j.comments ?? []);
      setActivities(j.activities ?? []);
    }
    setLoading(false);
  }, [companyId, authFetch]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function patch(patchBody: Record<string, unknown>) {
    setCompany((prev) => {
      if (!prev) return prev;
      if (
        patchBody.properties &&
        typeof patchBody.properties === "object" &&
        !Array.isArray(patchBody.properties)
      ) {
        const nextProps = { ...(prev.properties ?? {}) };
        for (const [k, v] of Object.entries(
          patchBody.properties as Record<string, unknown>,
        )) {
          if (v === null || v === undefined) delete nextProps[k];
          else if (
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean"
          ) {
            nextProps[k] = v;
          }
        }
        return { ...prev, properties: nextProps };
      }
      return { ...prev, ...patchBody };
    });
    await authFetch(`/api/crm/companies/${companyId}`, {
      method: "PATCH",
      body: JSON.stringify(patchBody),
    });
    onChanged();
    void load();
  }

  const tabs: { id: DrawerTab; label: string; icon: typeof Activity; count?: number }[] = [
    { id: "overview", label: "Overview", icon: Building2 },
    // Emails loads live Gmail on open — no pre-fetch badge (too slow).
    { id: "emails", label: "Emails", icon: Mail },
    { id: "comments", label: "Comments", icon: MessageSquare, count: comments.length },
    { id: "contacts", label: "Contacts", icon: Users, count: contacts.length },
    { id: "timeline", label: "Timeline", icon: Activity, count: activities.length },
    { id: "signals", label: "Product", icon: Zap },
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-neutral-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-base font-semibold text-white">
              {company?.name ?? "…"}
              {company?.isStale && <AlertTriangle className="size-4 text-amber-400" />}
            </h3>
            {company?.domain && (
              <a
                href={`https://${company.domain}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300"
              >
                {company.domain} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">
            <X className="size-5" />
          </button>
        </div>

        {/* Tabs — horizontal scroll when the row overflows (narrow drawer).
            The scrollbar itself is hidden: a visible track sitting under a
            7-item tab row reads as a rendering glitch, and the row is already
            swipe/wheel scrollable without it. A right-edge fade signals that
            there is more to reach. */}
        <div className="relative border-b border-white/[0.06]">
          <div className="overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-min gap-1 px-2">
            {tabs.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs transition whitespace-nowrap",
                    tab === t.id
                      ? "border-violet-400 text-white"
                      : "border-transparent text-neutral-500 hover:text-neutral-300",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  {t.label}
                  {t.count != null && t.count > 0 && (
                    <span className="rounded bg-white/10 px-1 text-[10px]">
                      {t.count}
                    </span>
                  )}
                </button>
              );
            })}
            </div>
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-neutral-950 to-transparent"
          />
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading || !company ? (
            <Loader2 className="mx-auto mt-8 size-5 animate-spin text-neutral-500" />
          ) : tab === "overview" ? (
            <OverviewTab
              company={company}
              members={members}
              fieldDefs={fieldDefs}
              onPatch={patch}
              authFetch={authFetch}
            />
          ) : tab === "emails" ? (
            <EmailsTab companyId={companyId} authFetch={authFetch} />
          ) : tab === "comments" ? (
            <CommentsTab
              companyId={companyId}
              comments={comments}
              authFetch={authFetch}
              onChange={load}
            />
          ) : tab === "contacts" ? (
            <ContactsTab
              companyId={companyId}
              contacts={contacts}
              authFetch={authFetch}
              onChange={load}
            />
          ) : tab === "timeline" ? (
            <TimelineTab activities={activities} />
          ) : (
            <SignalsTab companyId={companyId} orgId={company.orgId} authFetch={authFetch} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Emails tab (live Gmail search across connected mailboxes) ────────────

type EmailTimelineItem = {
  id: string;
  direction: "outbound" | "inbound";
  at: string;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  source: "gmail";
  mailboxEmail?: string;
  mailboxId?: string;
  sequenceName: string | null;
  contactEmail: string | null;
  contactName: string | null;
  status: string | null;
};

type MailboxSearchInfo = {
  id: string;
  fromEmail: string;
  ok: boolean;
  messageCount: number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
};

function EmailsTab({
  companyId,
  authFetch,
}: {
  companyId: string;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<EmailTimelineItem[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxSearchInfo[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [counts, setCounts] = useState({
    total: 0,
    outbound: 0,
    inbound: 0,
    threads: 0,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/crm/companies/${companyId}/emails`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed to load emails");
      setItems(j.items ?? []);
      setMailboxes(j.mailboxes ?? []);
      setQuery(typeof j.query === "string" ? j.query : null);
      setCounts(
        j.counts ?? { total: 0, outbound: 0, inbound: 0, threads: 0 },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load emails");
    } finally {
      setLoading(false);
    }
  }, [companyId, authFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12">
        <Loader2 className="size-5 animate-spin text-neutral-500" />
        <p className="text-xs text-neutral-500">
          Searching connected Gmail inboxes…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        {error}
      </div>
    );
  }

  const ready = mailboxes.filter((m) => m.ok);
  const skipped = mailboxes.filter((m) => m.skipped || !m.ok);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          Live Gmail search by domain + contacts across every connected
          mailbox.
          {counts.threads > 0 ? ` · ${counts.threads} thread(s)` : ""}
        </p>
        <div className="flex gap-2 text-[11px] text-neutral-500">
          <span className="rounded bg-white/5 px-1.5 py-0.5">
            {counts.outbound} out
          </span>
          <span className="rounded bg-white/5 px-1.5 py-0.5">
            {counts.inbound} in
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="text-neutral-400 hover:text-white"
            title="Search again"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Which mailboxes were searched */}
      <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40 px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
          Mailboxes
        </p>
        <ul className="mt-1.5 space-y-1">
          {mailboxes.length === 0 ? (
            <li className="text-xs text-neutral-500">
              No mailboxes. Connect Gmail in{" "}
              <a href="/settings" className="text-neutral-300 underline">
                Settings
              </a>
              .
            </li>
          ) : (
            mailboxes.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
              >
                <span className="font-medium text-neutral-200">
                  {m.fromEmail}
                </span>
                <span className="text-neutral-500">
                  {m.ok
                    ? `${m.messageCount} found`
                    : m.skipReason || m.error || "skipped"}
                </span>
              </li>
            ))
          )}
        </ul>
        {skipped.some((m) => m.skipReason?.includes("readonly")) && (
          <p className="mt-2 text-[11px] text-amber-400/90">
            To include work mail (e.g. @kodus.io), connect that Google account
            in Settings with Gmail read access — same OAuth as trykodus.
          </p>
        )}
        {query && (
          <p className="mt-2 truncate font-mono text-[10px] text-neutral-600">
            q: {query}
          </p>
        )}
      </div>

      {!query ? (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center">
          <Mail className="mx-auto size-7 text-neutral-600" />
          <p className="mt-3 text-sm font-medium text-neutral-300">
            Nothing to search yet
          </p>
          <p className="mt-1 text-xs text-pretty text-neutral-500">
            Set a <span className="text-neutral-300">domain</span> on this
            account and/or add contacts with email — then we search every
            connected Gmail for from/to that domain or address.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center">
          <Mail className="mx-auto size-7 text-neutral-600" />
          <p className="mt-3 text-sm font-medium text-neutral-300">
            No messages in connected inboxes
          </p>
          <p className="mt-1 text-xs text-pretty text-neutral-500">
            {ready.length === 0
              ? "Connect at least one Gmail with read access in Settings."
              : "Tried connected mailboxes — nothing matched this domain/contacts. If you chat from another address, connect that mailbox too."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((m) => {
            const open = expanded === m.id;
            const inbound = m.direction === "inbound";
            return (
              <li
                key={m.id}
                className={cn(
                  "rounded-xl border px-3 py-2.5",
                  inbound
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : "border-white/[0.06] bg-neutral-900/50",
                )}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setExpanded(open ? null : m.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                            inbound
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-sky-500/20 text-sky-300",
                          )}
                        >
                          {inbound ? "In" : "Out"}
                        </span>
                        {m.mailboxEmail && (
                          <span className="truncate text-[10px] text-neutral-500">
                            via {m.mailboxEmail}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-sm font-medium text-white">
                        {m.subject || "(no subject)"}
                      </p>
                      <p className="mt-0.5 text-[11px] text-neutral-500">
                        {formatRelative(m.at)}
                        {m.fromEmail ? ` · ${m.fromEmail}` : ""}
                        {m.toEmail ? ` → ${m.toEmail}` : ""}
                      </p>
                      {!open && m.snippet && (
                        <p className="mt-1 line-clamp-2 text-xs text-neutral-400">
                          {m.snippet}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
                {open && (
                  <div className="mt-2 border-t border-white/[0.06] pt-2">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-neutral-300">
                      {m.bodyText?.trim() || m.snippet || "—"}
                    </pre>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────

function OverviewTab({
  company,
  members,
  fieldDefs,
  onPatch,
  authFetch,
}: {
  company: CompanyWithIdle;
  members: TeamMember[];
  fieldDefs: CrmFieldDef[];
  onPatch: (p: Record<string, unknown>) => void;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [orgId, setOrgId] = useState(company.orgId ?? "");
  const [domain, setDomain] = useState(company.domain ?? "");
  const [industry, setIndustry] = useState(company.industry ?? "");
  const [devCount, setDevCount] = useState(
    company.devCount != null ? String(company.devCount) : "",
  );
  const [notes, setNotes] = useState(company.notes ?? "");

  // Keep local fields in sync when the drawer company changes.
  useEffect(() => {
    setOrgId(company.orgId ?? "");
    setDomain(company.domain ?? "");
    setIndustry(company.industry ?? "");
    setDevCount(company.devCount != null ? String(company.devCount) : "");
    setNotes(company.notes ?? "");
  }, [
    company.id,
    company.orgId,
    company.domain,
    company.industry,
    company.devCount,
    company.notes,
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <Select value={company.status} onValueChange={(v) => onPatch({ status: v })}>
            <SelectTrigger className="border-white/10 bg-neutral-900"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COMPANY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{STATUS_LABELS[s].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={company.priority} onValueChange={(v) => onPatch({ priority: v })}>
            <SelectTrigger className="border-white/10 bg-neutral-900"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COMPANY_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Owner">
          <Select
            value={company.ownerEmail || "none"}
            onValueChange={(v) => onPatch({ ownerEmail: v === "none" ? null : v })}
          >
            <SelectTrigger className="border-white/10 bg-neutral-900"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">—</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.email} value={m.email}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Last activity">
          <div className={cn("flex h-9 items-center px-1 text-sm", company.isStale ? "text-amber-300" : "text-neutral-300")}>
            {formatRelative(company.lastActivityAt)}
            {company.isStale && company.slaDays != null && (
              <span className="ml-1.5 text-xs text-amber-500/70">idle &gt; {company.slaDays}d</span>
            )}
          </div>
        </Field>
      </div>

      <Field label="Domain">
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onBlur={() => {
            const next = domain.trim();
            const current = company.domain ?? "";
            if (next !== current) onPatch({ domain: next || null });
          }}
          placeholder="frete.com"
          className="border-white/10 bg-neutral-900"
        />
        <p className="mt-1 text-[11px] text-neutral-500">
          Used by Emails tab to search Gmail (from/to/cc this domain).
        </p>
      </Field>

      {/* Custom properties */}
      <div className="space-y-2 rounded-lg border border-white/[0.06] bg-neutral-900/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Custom fields
          </p>
        </div>
        {fieldDefs.length === 0 ? (
          <p className="text-xs text-neutral-500">
            No custom fields yet. Use{" "}
            <span className="text-neutral-300">Manage fields</span> on the Accounts
            page to add properties (e.g. Self-hosted, Deployment).
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fieldDefs.map((def) => (
              <PropertyEditor
                key={def.id}
                def={def}
                value={company.properties?.[def.key]}
                onChange={(v) =>
                  onPatch({ properties: { [def.key]: v } })
                }
              />
            ))}
          </div>
        )}
      </div>

      <Field label="Product org">
        <OrgPicker
          value={orgId}
          onCommit={(v) => {
            setOrgId(v ?? "");
            onPatch({ orgId: v });
          }}
          authFetch={authFetch}
        />
      </Field>

      <Field label="Deployment">
        <Select
          value={company.deployment ?? "unknown"}
          onValueChange={(v) =>
            onPatch({ deployment: v === "unknown" ? null : v })
          }
        >
          <SelectTrigger className="h-8 border-white/10 bg-neutral-900 text-sm">
            <SelectValue placeholder="Deployment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unknown">Unknown</SelectItem>
            <SelectItem value="cloud">Cloud</SelectItem>
            <SelectItem value="self_hosted">Self-hosted</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Industry">
          <Input
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            onBlur={() => industry !== (company.industry ?? "") && onPatch({ industry: industry || null })}
            className="border-white/10 bg-neutral-900"
          />
        </Field>
        <Field label="Team size (devs)">
          <Input
            type="number"
            min={0}
            value={devCount}
            onChange={(e) => setDevCount(e.target.value)}
            onBlur={() => {
              const current = company.devCount != null ? String(company.devCount) : "";
              if (devCount !== current)
                onPatch({ devCount: devCount.trim() ? Number(devCount) : null });
            }}
            placeholder="ex: 40"
            className="border-white/10 bg-neutral-900"
          />
          <p className="mt-1 text-[11px] text-neutral-500">
            Engineering headcount (ICP). Not Kodus product seats — those are
            on the Product tab.
          </p>
        </Field>
      </div>

      <Field label="Notes">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (company.notes ?? "") && onPatch({ notes: notes || null })}
          rows={3}
          className="border-white/10 bg-neutral-900"
        />
      </Field>

      {Object.keys(company.enrichment ?? {}).length > 0 && (
        <Field label="Enrichment (from webhook)">
          <pre className="max-h-40 overflow-auto rounded-lg bg-black/40 p-3 text-[11px] text-neutral-300">
            {JSON.stringify(company.enrichment, null, 2)}
          </pre>
        </Field>
      )}
    </div>
  );
}

function PropertyEditor({
  def,
  value,
  onChange,
}: {
  def: CrmFieldDef;
  value: CrmPropertyValue | undefined;
  onChange: (v: CrmPropertyValue | null) => void;
}) {
  const [text, setText] = useState(
    value === undefined || value === null ? "" : String(value),
  );

  useEffect(() => {
    setText(value === undefined || value === null ? "" : String(value));
  }, [value, def.key]);

  if (def.type === "boolean") {
    const v =
      value === true ? "true" : value === false ? "false" : "unset";
    return (
      <Field label={def.label}>
        <Select
          value={v}
          onValueChange={(next) => {
            if (next === "unset") onChange(null);
            else onChange(next === "true");
          }}
        >
          <SelectTrigger className="border-white/10 bg-neutral-900">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unset">—</SelectItem>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    );
  }

  if (def.type === "select") {
    const current =
      typeof value === "string" && def.options.some((o) => o.id === value)
        ? value
        : "unset";
    return (
      <Field label={def.label}>
        <Select
          value={current}
          onValueChange={(next) =>
            onChange(next === "unset" ? null : next)
          }
        >
          <SelectTrigger className="border-white/10 bg-neutral-900">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unset">—</SelectItem>
            {def.options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }

  if (def.type === "number") {
    return (
      <Field label={def.label}>
        <Input
          type="number"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text.trim() === "") {
              if (value !== undefined && value !== null) onChange(null);
              return;
            }
            const n = Number(text);
            if (!Number.isFinite(n)) return;
            if (n !== value) onChange(n);
          }}
          className="border-white/10 bg-neutral-900"
        />
      </Field>
    );
  }

  return (
    <Field label={def.label}>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text;
          const prev = value === undefined || value === null ? "" : String(value);
          if (next === prev) return;
          onChange(next.trim() === "" ? null : next);
        }}
        className="border-white/10 bg-neutral-900"
      />
    </Field>
  );
}

// ── Manage custom fields ─────────────────────────────────────────────────

function ManageFieldsDialog({
  open,
  fields,
  authFetch,
  onClose,
  onChanged,
}: {
  open: boolean;
  fields: CrmFieldDef[];
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CrmFieldType>("text");
  const [optionsText, setOptionsText] = useState("Yes\nNo");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editOptionsText, setEditOptionsText] = useState("");

  function parseOptionsText(text: string): CrmFieldOption[] {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // "id|Label" or just "Label"
        const pipe = line.indexOf("|");
        if (pipe > 0) {
          return {
            id: line.slice(0, pipe).trim(),
            label: line.slice(pipe + 1).trim() || line.slice(0, pipe).trim(),
          };
        }
        return { id: "", label: line };
      });
  }

  async function createField() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { label, type };
      if (type === "select") {
        body.options = parseOptionsText(optionsText);
      }
      const res = await authFetch("/api/crm/fields", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (j as { error?: string }).error ??
            `Failed to create (HTTP ${res.status})`,
        );
      }
      setLabel("");
      setType("text");
      setOptionsText("Yes\nNo");
      // Parent reloads field list; keep dialog open so the new row is visible.
      await Promise.resolve(onChanged());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string, fieldType: CrmFieldType) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { label: editLabel };
      if (fieldType === "select") {
        body.options = parseOptionsText(editOptionsText);
      }
      const res = await authFetch(`/api/crm/fields/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed to update");
      setEditingId(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeField(id: string, fieldLabel: string) {
    if (
      !confirm(
        `Delete field “${fieldLabel}”? Values will no longer show on accounts (data may remain unused).`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`/api/crm/fields/${id}`, {
        method: "DELETE",
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed to delete");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function move(id: string, dir: -1 | 1) {
    const idx = fields.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= fields.length) return;
    const ordered = fields.map((f) => f.id);
    const tmp = ordered[idx];
    ordered[idx] = ordered[j];
    ordered[j] = tmp;
    setBusy(true);
    try {
      // sequential position updates
      await Promise.all(
        ordered.map((fid, position) =>
          authFetch(`/api/crm/fields/${fid}`, {
            method: "PATCH",
            body: JSON.stringify({ position }),
          }),
        ),
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto border-white/10 bg-neutral-950 text-white">
        <DialogHeader>
          <DialogTitle>Manage custom fields</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-neutral-500">
          Workspace properties on every account — like Notion database properties.
          Examples: Self-hosted (Yes/No), Deployment (select), internal notes (text).
        </p>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {fields.length === 0 ? (
            <p className="text-sm text-neutral-500">No fields yet.</p>
          ) : (
            fields.map((f, i) => (
              <div
                key={f.id}
                className="rounded-lg border border-white/[0.08] bg-neutral-900/50 p-3"
              >
                {editingId === f.id ? (
                  <div className="space-y-2">
                    <Input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      className="border-white/10 bg-neutral-900"
                    />
                    {f.type === "select" && (
                      <Textarea
                        value={editOptionsText}
                        onChange={(e) => setEditOptionsText(e.target.value)}
                        rows={3}
                        placeholder={"one option per line\noptional: id|Label"}
                        className="border-white/10 bg-neutral-900 font-mono text-xs"
                      />
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy || !editLabel.trim()}
                        onClick={() => void saveEdit(f.id, f.type)}
                        className="h-7 bg-white text-neutral-900"
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingId(null)}
                        className="h-7"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white">{f.label}</p>
                      <p className="text-[11px] text-neutral-500">
                        <span className="font-mono">{f.key}</span>
                        {" · "}
                        {f.type}
                        {f.type === "select" && f.options.length > 0
                          ? ` · ${f.options.map((o) => o.label).join(", ")}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        disabled={busy || i === 0}
                        onClick={() => void move(f.id, -1)}
                        className="rounded p-1 text-neutral-500 hover:text-white disabled:opacity-30"
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={busy || i === fields.length - 1}
                        onClick={() => void move(f.id, 1)}
                        className="rounded p-1 text-neutral-500 hover:text-white disabled:opacity-30"
                      >
                        <ArrowDown className="size-3.5" />
                      </button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setEditingId(f.id);
                          setEditLabel(f.label);
                          setEditOptionsText(
                            f.options
                              .map((o) =>
                                o.id === o.label ? o.label : `${o.id}|${o.label}`,
                              )
                              .join("\n"),
                          );
                        }}
                      >
                        Edit
                      </Button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void removeField(f.id, f.label)}
                        className="rounded p-1 text-neutral-600 hover:text-red-400"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs font-medium text-neutral-400">Add field</p>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Self-hosted)"
            className="border-white/10 bg-neutral-900"
          />
          <Select
            value={type}
            onValueChange={(v) => setType(v as CrmFieldType)}
          >
            <SelectTrigger className="border-white/10 bg-neutral-900">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CRM_FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {type === "select" && (
            <Textarea
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              rows={3}
              placeholder={"one option per line\nCloud\nSelf-hosted\nHybrid"}
              className="border-white/10 bg-neutral-900 font-mono text-xs"
            />
          )}
          <Button
            size="sm"
            disabled={busy || !label.trim()}
            onClick={() => void createField()}
            className="h-8 gap-1.5 bg-white text-neutral-900 hover:bg-neutral-200"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add field
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Comments tab (markdown) ──────────────────────────────────────────────

function CommentsTab({
  companyId,
  comments,
  authFetch,
  onChange,
}: {
  companyId: string;
  comments: CrmComment[];
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onChange: () => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!body.trim()) return;
    setSaving(true);
    await authFetch(`/api/crm/companies/${companyId}/comments`, {
      method: "POST",
      body: JSON.stringify({ bodyMd: body }),
    });
    setBody("");
    setSaving(false);
    onChange();
  }

  async function remove(id: string) {
    await authFetch(`/api/crm/comments/${id}`, { method: "DELETE" });
    onChange();
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/[0.06] bg-neutral-900/50 p-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment… markdown supported (**bold**, - lists, `code`)"
          rows={3}
          className="border-0 bg-transparent focus-visible:ring-0"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={saving || !body.trim()} className="h-7 bg-white text-neutral-900 hover:bg-neutral-200">
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Comment
          </Button>
        </div>
      </div>

      {comments.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">No comments yet.</p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div key={c.id} className="group rounded-lg border border-white/[0.06] bg-neutral-900/40 p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs text-neutral-400">
                  {c.authorEmail?.split("@")[0] ?? "system"} · {formatRelative(c.createdAt)}
                </span>
                <button onClick={() => remove(c.id)} className="text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <MarkdownContent text={c.bodyMd} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Contacts tab ─────────────────────────────────────────────────────────

function ContactsTab({
  companyId,
  contacts,
  authFetch,
  onChange,
}: {
  companyId: string;
  contacts: CrmContact[];
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onChange: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichNote, setEnrichNote] = useState<string | null>(null);

  async function enrich() {
    setEnriching(true);
    setEnrichNote(null);
    try {
      const res = await authFetch(`/api/crm/companies/${companyId}/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPeople: 5 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Enrichment failed");
      const r = json.result;
      setEnrichNote(
        r.note ??
          `${r.found} found · ${r.created} added · ${r.updated} filled in · ${r.skipped} already complete`,
      );
      onChange();
    } catch (e) {
      setEnrichNote(e instanceof Error ? e.message : "Enrichment failed");
    } finally {
      setEnriching(false);
    }
  }

  async function submit() {
    if (!name.trim()) return;
    setSaving(true);
    await authFetch(`/api/crm/companies/${companyId}/contacts`, {
      method: "POST",
      body: JSON.stringify({
        name,
        email: email || null,
        role: role || null,
        linkedin: linkedin || null,
      }),
    });
    setName("");
    setEmail("");
    setRole("");
    setLinkedin("");
    setSaving(false);
    onChange();
  }

  async function remove(id: string) {
    await authFetch(`/api/crm/contacts/${id}`, { method: "DELETE" });
    onChange();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name *" className="border-white/10 bg-neutral-900" />
        <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" className="border-white/10 bg-neutral-900" />
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="border-white/10 bg-neutral-900" />
      </div>
      <Input
        type="url"
        value={linkedin}
        onChange={(e) => setLinkedin(e.target.value)}
        placeholder="LinkedIn URL (optional)"
        className="border-white/10 bg-neutral-900"
      />
      <div className="flex items-center justify-between gap-2">
        {/* Billed per call, so it is a deliberate click rather than something
            that happens on open. */}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void enrich()}
          disabled={enriching}
          className="h-7 gap-1.5 border-white/10"
          title="Look up people at this company (name, role, LinkedIn)"
        >
          {enriching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          Find people
        </Button>
        <Button size="sm" onClick={submit} disabled={saving || !name.trim()} className="h-7 gap-1.5 bg-white text-neutral-900 hover:bg-neutral-200">
          <Plus className="size-3.5" /> Add contact
        </Button>
      </div>
      {enrichNote && (
        <p className="text-xs text-neutral-400">{enrichNote}</p>
      )}

      {contacts.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">No contacts yet.</p>
      ) : (
        <div className="space-y-2">
          {contacts.map((c) =>
            editingId === c.id ? (
              <ContactEditRow
                key={c.id}
                contact={c}
                authFetch={authFetch}
                onDone={() => {
                  setEditingId(null);
                  onChange();
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div key={c.id} className="group flex items-center justify-between rounded-lg border border-white/[0.06] bg-neutral-900/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-100">
                    {c.name} {c.role && <span className="text-neutral-500">· {c.role}</span>}
                  </p>
                  {c.email && <p className="truncate text-xs text-neutral-500">{c.email}</p>}
                  {c.linkedin && (
                    <a
                      href={c.linkedin}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300"
                    >
                      LinkedIn <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => setEditingId(c.id)}
                    aria-label={`Edit ${c.name}`}
                    className="text-neutral-600 hover:text-neutral-200"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    onClick={() => remove(c.id)}
                    aria-label={`Delete ${c.name}`}
                    className="text-neutral-600 hover:text-red-400"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ContactEditRow({
  contact,
  authFetch,
  onDone,
  onCancel,
}: {
  contact: CrmContact;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(contact.name);
  const [role, setRole] = useState(contact.role ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [linkedin, setLinkedin] = useState(contact.linkedin ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`/api/crm/contacts/${contact.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, role, email, linkedin }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Failed to save");
        return;
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-white/[0.12] bg-neutral-900/60 px-3 py-2.5">
      <div className="grid grid-cols-3 gap-2">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name *"
          className="h-8 border-white/10 bg-neutral-900"
        />
        <Input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Role"
          className="h-8 border-white/10 bg-neutral-900"
        />
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="h-8 border-white/10 bg-neutral-900"
        />
      </div>
      <Input
        type="url"
        value={linkedin}
        onChange={(e) => setLinkedin(e.target.value)}
        placeholder="LinkedIn URL (optional)"
        className="h-8 border-white/10 bg-neutral-900"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
          className="h-7 text-neutral-400 hover:text-neutral-100"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={saving || !name.trim()}
          className="h-7 bg-white text-neutral-900 hover:bg-neutral-200"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ── Timeline tab ─────────────────────────────────────────────────────────

function TimelineTab({ activities }: { activities: CrmActivity[] }) {
  if (activities.length === 0) {
    return <p className="py-6 text-center text-sm text-neutral-500">No activity yet.</p>;
  }
  return (
    <div className="space-y-0">
      {activities.map((a, i) => (
        <div key={a.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className="mt-1 size-2 rounded-full bg-violet-400" />
            {i < activities.length - 1 && <div className="w-px flex-1 bg-white/[0.08]" />}
          </div>
          <div className="pb-4">
            <p className="text-sm text-neutral-200">{a.summary ?? a.kind}</p>
            <p className="text-xs text-neutral-500">
              {a.kind} · {a.actorEmail?.split("@")[0] ?? "system"} · {formatRelative(a.createdAt)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Signals tab ──────────────────────────────────────────────────────────

function SignalsTab({
  companyId,
  orgId,
  authFetch,
}: {
  companyId: string;
  orgId: string | null;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [signals, setSignals] = useState<ProductSignals | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    setLoading(true);
    authFetch(`/api/crm/companies/${companyId}/signals`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setErr(j.error);
        else setSignals(j.signals);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [companyId, orgId, authFetch]);

  if (!orgId) {
    return (
      <p className="py-8 text-center text-sm text-neutral-500">
        Link a <span className="text-neutral-300">Product org id</span> in Overview to pull real usage signals.
      </p>
    );
  }
  if (loading) return <Loader2 className="mx-auto mt-8 size-5 animate-spin text-neutral-500" />;
  if (err) return <p className="py-6 text-center text-sm text-red-400">{err}</p>;
  if (!signals || !signals.found) {
    return <p className="py-8 text-center text-sm text-neutral-500">No product org found for this id.</p>;
  }

  const health = HEALTH_LABELS[signals.health] ?? HEALTH_LABELS.unknown;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-neutral-900/40 p-3">
        <div>
          <p className="text-sm font-medium text-white">{signals.name ?? "—"}</p>
          <p className="text-xs text-neutral-500">signed up {formatRelative(signals.signupAt)}</p>
        </div>
        <Badge className={cn("border-0", health.className)}>{health.label}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <SignalCell label="Plan" value={signals.planType ?? signals.subscriptionStatus ?? "—"} />
        <SignalCell label="Seats" value={signals.assignedLicenses != null ? `${signals.assignedLicenses}/${signals.totalLicenses ?? "?"}` : "—"} />
        <SignalCell
          label="Users in Kodus"
          value={signals.userCount != null ? String(signals.userCount) : "—"}
        />
        <SignalCell label="Trial ends" value={formatDeadline(signals.trialEnd)} />
        <SignalCell label="Reviews 7d" value={signals.reviews7d != null ? String(signals.reviews7d) : "—"} />
        <SignalCell
          label="Suggestions applied 30d"
          value={formatImplementationRate(
            signals.suggestionsImplemented30d,
            signals.suggestionsPartial30d,
            signals.suggestions30d,
          )}
          full
        />
        <SignalCell
          label="Skipped reviews 30d"
          value={signals.skips30d != null ? String(signals.skips30d) : "—"}
        />
        <SignalCell label="Reviews 30d" value={signals.reviews30d != null ? String(signals.reviews30d) : "—"} />
        <SignalCell label="Last review" value={formatRelative(signals.lastReviewAt)} full />
        {(signals.skips30d ?? 0) > 0 && (
          // Keyed off the skip count, not the message. An org skipping every
          // review with no reason recorded is the most blocked one there is,
          // and a truthiness guard on the message would hide exactly that.
          <SignalCell
            label="Top skip reason"
            value={signals.topSkipReason ?? "not recorded"}
            full
          />
        )}
      </div>
    </div>
  );
}

function SignalCell({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={cn("rounded-lg border border-white/[0.06] bg-neutral-900/40 px-3 py-2", full && "col-span-2")}>
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm text-neutral-100">{value}</p>
    </div>
  );
}
