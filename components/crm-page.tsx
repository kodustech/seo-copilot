"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  Activity,
  MessageSquare,
  Users,
  Zap,
  ExternalLink,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import {
  COMPANY_PRIORITIES,
  COMPANY_STATUSES,
  type CompanyPriority,
  type CompanyStatus,
  type CompanyWithIdle,
  type CrmActivity,
  type CrmComment,
  type CrmContact,
} from "@/lib/crm";
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
  qualified: { label: "Qualified", className: "bg-sky-500/20 text-sky-300" },
  trial: { label: "Trial", className: "bg-amber-500/20 text-amber-300" },
  negotiation: { label: "Negotiation", className: "bg-violet-500/20 text-violet-300" },
  customer: { label: "Customer", className: "bg-emerald-500/20 text-emerald-300" },
  churned: { label: "Churned", className: "bg-red-500/20 text-red-300" },
  lost: { label: "Lost", className: "bg-neutral-700/40 text-neutral-500" },
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
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [staleOnly, setStaleOnly] = useState(false);
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
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

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
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
  }, [token, statusFilter, ownerFilter, staleOnly, search, authFetch]);

  useEffect(() => {
    void load();
  }, [load]);

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
            (stats.byStatus.qualified ?? 0) +
            (stats.byStatus.trial ?? 0) +
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

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <Table>
          <TableHeader>
            <TableRow className="border-white/[0.06] hover:bg-transparent">
              <TableHead className="text-neutral-500">Company</TableHead>
              <TableHead className="text-neutral-500">Status</TableHead>
              <TableHead className="text-neutral-500">Priority</TableHead>
              <TableHead className="text-neutral-500">Owner</TableHead>
              <TableHead className="text-neutral-500">Last activity</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && companies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-neutral-500">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : companies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-neutral-500">
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

      {selectedId && (
        <CompanyDrawer
          companyId={selectedId}
          members={members}
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
            <Field label="Product org id">
              <Input value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="uuid (optional)" className="border-white/10 bg-neutral-900" />
            </Field>
          </div>
          <Field label="Qtd. de devs">
            <Input
              type="number"
              min={0}
              value={devCount}
              onChange={(e) => setDevCount(e.target.value)}
              placeholder="ex: 120"
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

// ---------------------------------------------------------------------------
// Company drawer
// ---------------------------------------------------------------------------

type DrawerTab = "overview" | "comments" | "contacts" | "timeline" | "signals";

function CompanyDrawer({
  companyId,
  members,
  authFetch,
  onClose,
  onChanged,
}: {
  companyId: string;
  members: TeamMember[];
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
    setCompany((prev) => (prev ? { ...prev, ...patchBody } : prev));
    await authFetch(`/api/crm/companies/${companyId}`, {
      method: "PATCH",
      body: JSON.stringify(patchBody),
    });
    onChanged();
    void load();
  }

  const tabs: { id: DrawerTab; label: string; icon: typeof Activity; count?: number }[] = [
    { id: "overview", label: "Overview", icon: Building2 },
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

        {/* Tabs */}
        <div className="flex gap-1 border-b border-white/[0.06] px-2">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs transition",
                  tab === t.id
                    ? "border-violet-400 text-white"
                    : "border-transparent text-neutral-500 hover:text-neutral-300",
                )}
              >
                <Icon className="size-3.5" />
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="rounded bg-white/10 px-1 text-[10px]">{t.count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading || !company ? (
            <Loader2 className="mx-auto mt-8 size-5 animate-spin text-neutral-500" />
          ) : tab === "overview" ? (
            <OverviewTab company={company} members={members} onPatch={patch} />
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

// ── Overview tab ──────────────────────────────────────────────────────────

function OverviewTab({
  company,
  members,
  onPatch,
}: {
  company: CompanyWithIdle;
  members: TeamMember[];
  onPatch: (p: Record<string, unknown>) => void;
}) {
  const [orgId, setOrgId] = useState(company.orgId ?? "");
  const [industry, setIndustry] = useState(company.industry ?? "");
  const [devCount, setDevCount] = useState(
    company.devCount != null ? String(company.devCount) : "",
  );
  const [notes, setNotes] = useState(company.notes ?? "");

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

      <Field label="Product org id">
        <div className="flex gap-2">
          <Input
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            onBlur={() => orgId !== (company.orgId ?? "") && onPatch({ orgId: orgId || null })}
            placeholder="Link to product org uuid"
            className="border-white/10 bg-neutral-900 font-mono text-xs"
          />
        </div>
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
        <Field label="Qtd. de devs">
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
            placeholder="ex: 120"
            className="border-white/10 bg-neutral-900"
          />
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
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setSaving(true);
    await authFetch(`/api/crm/companies/${companyId}/contacts`, {
      method: "POST",
      body: JSON.stringify({ name, email: email || null, role: role || null }),
    });
    setName("");
    setEmail("");
    setRole("");
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
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={saving || !name.trim()} className="h-7 gap-1.5 bg-white text-neutral-900 hover:bg-neutral-200">
          <Plus className="size-3.5" /> Add contact
        </Button>
      </div>

      {contacts.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">No contacts yet.</p>
      ) : (
        <div className="space-y-2">
          {contacts.map((c) => (
            <div key={c.id} className="group flex items-center justify-between rounded-lg border border-white/[0.06] bg-neutral-900/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-100">
                  {c.name} {c.role && <span className="text-neutral-500">· {c.role}</span>}
                </p>
                {c.email && <p className="truncate text-xs text-neutral-500">{c.email}</p>}
              </div>
              <button onClick={() => remove(c.id)} className="text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
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
        <SignalCell label="Users" value={signals.userCount != null ? String(signals.userCount) : "—"} />
        <SignalCell label="Trial ends" value={signals.trialEnd ? formatRelative(signals.trialEnd) : "—"} />
        <SignalCell label="Reviews 7d" value={signals.reviews7d != null ? String(signals.reviews7d) : "—"} />
        <SignalCell label="Reviews 30d" value={signals.reviews30d != null ? String(signals.reviews30d) : "—"} />
        <SignalCell label="Last review" value={formatRelative(signals.lastReviewAt)} full />
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
