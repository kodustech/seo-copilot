"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  ExternalLink,
  Trash2,
  Loader2,
  Search,
  Send,
  RefreshCw,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import {
  PROSPECT_PRIORITIES,
  PROSPECT_STATUSES,
  PROSPECT_TARGET_TYPES,
  type OutreachProspect,
  type ProspectPriority,
  type ProspectStatus,
  type ProspectTargetType,
} from "@/lib/outreach";

import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Constants — labels + colors
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<ProspectStatus, { label: string; className: string }> = {
  prospect: { label: "Prospect", className: "bg-neutral-500/20 text-neutral-300" },
  researching: { label: "Researching", className: "bg-amber-500/20 text-amber-300" },
  drafted: { label: "Drafted", className: "bg-violet-500/20 text-violet-300" },
  contacted: { label: "Contacted", className: "bg-sky-500/20 text-sky-300" },
  replied: { label: "Replied", className: "bg-blue-500/20 text-blue-300" },
  won: { label: "Won", className: "bg-emerald-500/20 text-emerald-300" },
  lost: { label: "Lost", className: "bg-red-500/20 text-red-300" },
  snoozed: { label: "Snoozed", className: "bg-neutral-700/30 text-neutral-500" },
};

const TARGET_LABELS: Record<ProspectTargetType, string> = {
  listicle: "Listicle",
  guest_post: "Guest post",
  podcast: "Podcast",
  awesome_list: "Awesome list",
  article: "Article",
  newsletter: "Newsletter",
  other: "Other",
};

const PRIORITY_BADGE: Record<ProspectPriority, string> = {
  high: "bg-red-500/15 text-red-300",
  medium: "bg-sky-500/15 text-sky-300",
  low: "bg-neutral-500/15 text-neutral-400",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TeamMember = { email: string; label: string };

function shortenUrl(raw: string | null): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname.replace(/^www\./, "")}${path}`.slice(0, 50);
  } catch {
    return raw.slice(0, 50);
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "—";
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function formatDateInput(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OutreachPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [prospects, setProspects] = useState<OutreachProspect[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ProspectStatus | "all">(
    "all",
  );
  const [targetFilter, setTargetFilter] = useState<ProspectTargetType | "all">(
    "all",
  );
  const [responsibleFilter, setResponsibleFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OutreachProspect | null>(null);

  // Auth token
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  // Team members for assignee picker
  useEffect(() => {
    if (!token) return;
    fetch("/api/team/members", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const members = data?.members as TeamMember[] | undefined;
        if (members && members.length > 0) setTeamMembers(members);
      })
      .catch(() => {});
  }, [token]);

  const fetchProspects = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (targetFilter !== "all") params.set("targetType", targetFilter);
      if (responsibleFilter !== "all")
        params.set("responsibleEmail", responsibleFilter);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/outreach/prospects?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setProspects(data.prospects ?? []);
      setStats((data.stats?.byStatus as Record<string, number>) ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProspects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, statusFilter, targetFilter, responsibleFilter]);

  // Debounce search
  useEffect(() => {
    if (!token) return;
    const handle = setTimeout(fetchProspects, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const updateInline = async (
    id: string,
    updates: Partial<OutreachProspect>,
  ) => {
    if (!token) return;
    // Optimistic update
    setProspects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    );
    try {
      const res = await fetch(`/api/outreach/prospects/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch {
      // Revert on error
      fetchProspects();
    }
  };

  const removeProspect = async (id: string) => {
    if (!token || !confirm("Delete this prospect?")) return;
    try {
      const res = await fetch(`/api/outreach/prospects/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      setProspects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const total = prospects.length;
  const won = stats["won"] || 0;
  const contacted = (stats["contacted"] || 0) + (stats["replied"] || 0);
  const open =
    (stats["prospect"] || 0) +
    (stats["researching"] || 0) +
    (stats["drafted"] || 0);

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-6 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Send className="h-6 w-6 text-violet-400" />
            Outreach CRM
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {open} open · {contacted} in flight · {won} won
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-300 transition hover:bg-violet-500/20"
          >
            <Plus className="h-4 w-4" />
            Add prospect
          </button>
          <button
            onClick={fetchProspects}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-white/10 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
        >
          <SelectTrigger className="h-9 w-36 border-white/10 bg-neutral-900 text-xs text-neutral-200">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
            <SelectItem value="all">Any status</SelectItem>
            {PROSPECT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label} ({stats[s] || 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={targetFilter}
          onValueChange={(v) => setTargetFilter(v as typeof targetFilter)}
        >
          <SelectTrigger className="h-9 w-36 border-white/10 bg-neutral-900 text-xs text-neutral-200">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
            <SelectItem value="all">Any type</SelectItem>
            {PROSPECT_TARGET_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TARGET_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={responsibleFilter}
          onValueChange={setResponsibleFilter}
        >
          <SelectTrigger className="h-9 w-36 border-white/10 bg-neutral-900 text-xs text-neutral-200">
            <SelectValue placeholder="Responsible" />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
            <SelectItem value="all">Everyone</SelectItem>
            {teamMembers.map((m) => (
              <SelectItem key={m.email} value={m.email}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-neutral-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search domain, contact, notes…"
            className="h-9 w-72 border-white/10 bg-neutral-900 pl-7 text-xs text-neutral-200"
          />
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {/* Table */}
      <div className="rounded-xl border border-white/[0.06] bg-neutral-900/40">
        <Table>
          <TableHeader>
            <TableRow className="border-white/10">
              <TableHead className="w-32 text-neutral-400">Status</TableHead>
              <TableHead className="text-neutral-400">Domain / URL</TableHead>
              <TableHead className="w-28 text-neutral-400">Type</TableHead>
              <TableHead className="text-neutral-400">Contact</TableHead>
              <TableHead className="w-12 text-right text-neutral-400">DR</TableHead>
              <TableHead className="w-28 text-neutral-400">Priority</TableHead>
              <TableHead className="w-32 text-neutral-400">Responsible</TableHead>
              <TableHead className="w-24 text-neutral-400">Last touch</TableHead>
              <TableHead className="w-16 text-neutral-400" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && prospects.length === 0 ? (
              <TableRow className="border-white/5">
                <TableCell
                  colSpan={9}
                  className="py-12 text-center text-neutral-500"
                >
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : prospects.length === 0 ? (
              <TableRow className="border-white/5">
                <TableCell
                  colSpan={9}
                  className="py-12 text-center text-neutral-500"
                >
                  No prospects yet. Click "Add prospect" to start.
                </TableCell>
              </TableRow>
            ) : (
              prospects.map((p) => (
                <TableRow
                  key={p.id}
                  className="border-white/5 hover:bg-white/[0.02]"
                >
                  <TableCell>
                    <Select
                      value={p.status}
                      onValueChange={(v) =>
                        updateInline(p.id, {
                          status: v as ProspectStatus,
                          lastTouchAt:
                            v === "contacted" || v === "replied"
                              ? new Date().toISOString()
                              : p.lastTouchAt,
                        })
                      }
                    >
                      <SelectTrigger
                        className={cn(
                          "h-7 w-28 border-none px-2 text-[11px]",
                          STATUS_LABELS[p.status].className,
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                        {PROSPECT_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {STATUS_LABELS[s].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell
                    className="cursor-pointer max-w-[300px] truncate text-neutral-200"
                    onClick={() => setEditing(p)}
                    title={p.url || p.domain}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{p.domain}</span>
                      {p.url && (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-neutral-600 hover:text-neutral-300"
                        >
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                    {p.url && (
                      <div className="text-[10px] text-neutral-600">
                        {shortenUrl(p.url)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-[11px] text-neutral-400">
                    {TARGET_LABELS[p.targetType]}
                  </TableCell>
                  <TableCell className="text-[11px] text-neutral-300">
                    {p.contactName || p.contactEmail ? (
                      <div>
                        {p.contactName && <div>{p.contactName}</div>}
                        {p.contactEmail && (
                          <div className="text-[10px] text-neutral-500">
                            {p.contactEmail}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-[11px] text-neutral-300">
                    {p.dr ?? <span className="text-neutral-600">—</span>}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.priority}
                      onValueChange={(v) =>
                        updateInline(p.id, { priority: v as ProspectPriority })
                      }
                    >
                      <SelectTrigger
                        className={cn(
                          "h-6 w-20 border-none px-2 text-[10px]",
                          PRIORITY_BADGE[p.priority],
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                        {PROSPECT_PRIORITIES.map((pr) => (
                          <SelectItem key={pr} value={pr}>
                            {pr}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.responsibleEmail ?? "__unassigned__"}
                      onValueChange={(v) =>
                        updateInline(p.id, {
                          responsibleEmail:
                            v === "__unassigned__" ? null : v,
                        })
                      }
                    >
                      <SelectTrigger className="h-7 border-none bg-transparent px-2 text-[11px] text-neutral-300 hover:bg-white/5">
                        <SelectValue placeholder="Unassigned" />
                      </SelectTrigger>
                      <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                        <SelectItem value="__unassigned__">
                          Unassigned
                        </SelectItem>
                        {teamMembers.map((m) => (
                          <SelectItem key={m.email} value={m.email}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-[11px] text-neutral-500">
                    {formatRelative(p.lastTouchAt)}
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => removeProspect(p.id)}
                      className="rounded p-1 text-neutral-600 transition hover:bg-red-500/10 hover:text-red-400"
                      aria-label="Delete prospect"
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

      {/* Total */}
      {!loading && total > 0 && (
        <p className="mt-3 text-xs text-neutral-600">
          Showing {total} prospect{total === 1 ? "" : "s"}
        </p>
      )}

      {/* Create / Edit dialogs */}
      {creating && (
        <ProspectFormDialog
          mode="create"
          token={token}
          teamMembers={teamMembers}
          onClose={() => setCreating(false)}
          onSaved={(p) => {
            setProspects((prev) => [p, ...prev]);
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <ProspectFormDialog
          mode="edit"
          token={token}
          teamMembers={teamMembers}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setProspects((prev) =>
              prev.map((it) => (it.id === p.id ? p : it)),
            );
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form dialog (create + edit)
// ---------------------------------------------------------------------------

function ProspectFormDialog({
  mode,
  token,
  teamMembers,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  token: string | null;
  teamMembers: TeamMember[];
  initial?: OutreachProspect;
  onClose: () => void;
  onSaved: (p: OutreachProspect) => void;
}) {
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [targetType, setTargetType] = useState<ProspectTargetType>(
    initial?.targetType ?? "listicle",
  );
  const [contactName, setContactName] = useState(initial?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(
    initial?.contactEmail ?? "",
  );
  const [contactUrl, setContactUrl] = useState(initial?.contactUrl ?? "");
  const [dr, setDr] = useState<string>(
    initial?.dr ? String(initial.dr) : "",
  );
  const [niche, setNiche] = useState(initial?.niche ?? "");
  const [status, setStatus] = useState<ProspectStatus>(
    initial?.status ?? "prospect",
  );
  const [priority, setPriority] = useState<ProspectPriority>(
    initial?.priority ?? "medium",
  );
  const [nextFollowupAt, setNextFollowupAt] = useState(
    formatDateInput(initial?.nextFollowupAt ?? null),
  );
  const [responsibleEmail, setResponsibleEmail] = useState(
    initial?.responsibleEmail ?? "",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!token) return;
    if (!domain.trim()) {
      setError("Domain is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        domain: domain.trim(),
        url: url.trim() || null,
        targetType,
        contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim() || null,
        contactUrl: contactUrl.trim() || null,
        dr: dr.trim() ? Number(dr) : null,
        niche: niche.trim() || null,
        status,
        priority,
        nextFollowupAt: nextFollowupAt
          ? new Date(nextFollowupAt).toISOString()
          : null,
        responsibleEmail: responsibleEmail || null,
        notes: notes.trim() || null,
      };
      const url2 =
        mode === "create"
          ? "/api/outreach/prospects"
          : `/api/outreach/prospects/${initial?.id}`;
      const res = await fetch(url2, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed");
      onSaved(data.prospect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto border-white/10 bg-neutral-950 text-neutral-100">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add prospect" : "Edit prospect"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Domain *">
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="techcrunch.com"
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
          <Field label="URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://techcrunch.com/best-ai-code-review-tools/"
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Target type">
              <Select
                value={targetType}
                onValueChange={(v) =>
                  setTargetType(v as ProspectTargetType)
                }
              >
                <SelectTrigger className="border-white/10 bg-neutral-900 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                  {PROSPECT_TARGET_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TARGET_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as ProspectStatus)}
              >
                <SelectTrigger className="border-white/10 bg-neutral-900 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                  {PROSPECT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact name">
              <Input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
            <Field label="Contact email">
              <Input
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="email@domain.com"
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
          </div>
          <Field label="Contact URL">
            <Input
              value={contactUrl}
              onChange={(e) => setContactUrl(e.target.value)}
              placeholder="https://x.com/handle"
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="DR">
              <Input
                value={dr}
                onChange={(e) => setDr(e.target.value)}
                inputMode="numeric"
                placeholder="0-100"
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
            <Field label="Niche">
              <Input
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder="dev tools"
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
            <Field label="Priority">
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as ProspectPriority)}
              >
                <SelectTrigger className="border-white/10 bg-neutral-900 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                  {PROSPECT_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Next follow-up">
              <Input
                type="date"
                value={nextFollowupAt}
                onChange={(e) => setNextFollowupAt(e.target.value)}
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
            <Field label="Responsible">
              <Select
                value={responsibleEmail || "__unassigned__"}
                onValueChange={(v) =>
                  setResponsibleEmail(v === "__unassigned__" ? "" : v)
                }
              >
                <SelectTrigger className="border-white/10 bg-neutral-900 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {teamMembers.map((m) => (
                    <SelectItem key={m.email} value={m.email}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Pitch angle, last reply, anything to remember…"
              rows={4}
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
          {initial?.source && (
            <p className="text-xs text-neutral-500">
              Source: <Badge variant="outline">{initial.source}</Badge>
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <DialogFooter>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-neutral-300 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !domain.trim()}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
          >
            {saving
              ? "Saving…"
              : mode === "create"
                ? "Add prospect"
                : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] uppercase tracking-wider text-neutral-500">
        {label}
      </label>
      {children}
    </div>
  );
}
