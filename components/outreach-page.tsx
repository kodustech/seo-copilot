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
  Sparkles,
  CheckCircle2,
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
  partnership: "Partnership",
  link_reclamation: "Link reclamation",
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

  // Contact discovery — scrapes the domain + article URL via the LLM and
  // surfaces a ranked list of candidate contacts (name + email).
  type VerificationStatus =
    | "valid"
    | "invalid"
    | "disposable"
    | "catchall"
    | "unknown"
    | "error"
    | "config_missing";
  type ContactCandidate = {
    name: string;
    role: string | null;
    email: string | null;
    emailConfidence: "verified" | "high" | "medium" | "low" | null;
    emailSource: "scraped" | "guessed";
    profileUrl: string | null;
    source: string;
    notes: string | null;
    verification?: {
      status: VerificationStatus;
      flags: string[];
      suggestedCorrection: string | null;
      error: string | null;
    };
  };
  const [candidates, setCandidates] = useState<ContactCandidate[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [hasMx, setHasMx] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const verifyAllCandidates = async () => {
    if (!token || verifying) return;
    const emails = Array.from(
      new Set(
        candidates
          .filter((c) => c.email && !c.verification)
          .map((c) => c.email!.toLowerCase()),
      ),
    );
    if (emails.length === 0) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await fetch("/api/outreach/verify-emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ emails }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Verification failed");

      type ApiResult = {
        email: string;
        status: VerificationStatus;
        flags: string[];
        suggestedCorrection: string | null;
        error: string | null;
      };
      const map = new Map<string, ApiResult>();
      for (const r of (data.results ?? []) as ApiResult[]) {
        map.set(r.email.toLowerCase(), r);
      }

      // Special-case the missing-config error so the user knows what to do.
      const firstResult = (data.results ?? [])[0] as ApiResult | undefined;
      if (firstResult?.status === "config_missing") {
        setVerifyError(
          firstResult.error ?? "NEVERBOUNCE_API_KEY not configured.",
        );
      }

      setCandidates((prev) => {
        const next = prev.map((c) => {
          const v = c.email
            ? map.get(c.email.toLowerCase())
            : undefined;
          if (!v) return c;
          return {
            ...c,
            verification: {
              status: v.status,
              flags: v.flags,
              suggestedCorrection: v.suggestedCorrection,
              error: v.error,
            },
          };
        });
        // Re-sort: valid → catchall/unknown → invalid/disposable.
        const order: Record<string, number> = {
          valid: 0,
          unknown: 1,
          catchall: 2,
          disposable: 3,
          invalid: 4,
          error: 5,
          config_missing: 6,
        };
        return [...next].sort((a, b) => {
          const ar = a.verification?.status
            ? order[a.verification.status] ?? 7
            : 7;
          const br = b.verification?.status
            ? order[b.verification.status] ?? 7
            : 7;
          return ar - br;
        });
      });
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Failed");
    } finally {
      setVerifying(false);
    }
  };

  const runDiscovery = async () => {
    if (!token || discovering || !domain.trim()) return;
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const res = await fetch("/api/outreach/discover-contacts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          domain: domain.trim(),
          articleUrl: url.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed");
      setCandidates(data.contacts ?? []);
      setHasMx(data.hasMx ?? null);
      if ((data.contacts ?? []).length === 0) {
        setDiscoveryError(
          "No contacts found on /about, /team, or the article page.",
        );
      }
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : "Failed");
    } finally {
      setDiscovering(false);
    }
  };

  const applyCandidate = (c: ContactCandidate) => {
    if (c.name && c.name !== c.email?.split("@")[0]) setContactName(c.name);
    if (c.email) setContactEmail(c.email);
    if (c.profileUrl) setContactUrl(c.profileUrl);
  };

  // Pure client-side email pattern generator — no scraping, no LLM. Used
  // when the user already knows the contact name + domain and just wants
  // the most likely email patterns to try (or to feed into a paid email
  // verifier later).
  const guessEmailsFromName = () => {
    const name = contactName.trim();
    const cleanDomain = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
    if (!name || !cleanDomain) return;

    setDiscoveryError(null);
    setHasMx(null);

    const parts = name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    if (parts.length === 0) return;
    const first = parts[0];
    const last = parts[parts.length - 1];
    const fInitial = first[0];
    const lInitial = last[0];

    const patterns =
      parts.length === 1 || first === last
        ? [`${first}@${cleanDomain}`]
        : Array.from(
            new Set([
              `${first}@${cleanDomain}`,
              `${first}.${last}@${cleanDomain}`,
              `${fInitial}${last}@${cleanDomain}`,
              `${first}${last}@${cleanDomain}`,
              `${first}_${last}@${cleanDomain}`,
              `${fInitial}.${last}@${cleanDomain}`,
              `${first}.${lInitial}@${cleanDomain}`,
              `${last}@${cleanDomain}`,
            ]),
          );

    setCandidates(
      patterns.map((email, i) => ({
        name,
        role: null,
        email,
        emailConfidence: i === 0 ? "medium" : "low",
        emailSource: "guessed",
        profileUrl: null,
        source: `pattern from "${name}" + ${cleanDomain}`,
        notes: null,
      })),
    );
  };

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

          {/* Find contacts — scrape /about, /team, the article URL, then
              extract people + likely emails via LLM. Click any suggestion
              to apply name / email / profile URL to the form.
              "Guess from name" is a pure client-side fallback when scraping
              finds nothing or you already know the contact name. */}
          <div className="-mt-1 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runDiscovery}
              disabled={!domain.trim() || discovering}
              className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-300 transition hover:bg-violet-500/20 disabled:opacity-50"
              title={
                domain.trim()
                  ? "Scrape /about, /team, the article URL and extract contacts via LLM"
                  : "Enter a domain first"
              }
            >
              {discovering ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              {discovering ? "Searching…" : "Find contacts"}
            </button>
            <button
              type="button"
              onClick={guessEmailsFromName}
              disabled={!domain.trim() || !contactName.trim() || discovering}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-neutral-300 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
              title={
                contactName.trim()
                  ? `Generate likely email patterns for "${contactName}" @ ${domain}`
                  : "Type a contact name first"
              }
            >
              <Sparkles className="size-3" />
              Guess from name
            </button>
            {hasMx === false && (
              <span
                className="text-[10px] text-amber-400"
                title="No MX record — domain doesn't accept email"
              >
                no MX record
              </span>
            )}
            {discoveryError && (
              <span className="text-[11px] text-red-400">{discoveryError}</span>
            )}
          </div>

          {candidates.length > 0 && (
            <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40">
              {/* Verify-all toolbar */}
              <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-2 py-1.5">
                <span className="text-[10px] text-neutral-500">
                  {candidates.length} candidate
                  {candidates.length === 1 ? "" : "s"} · click to apply
                </span>
                <div className="flex items-center gap-2">
                  {verifyError && (
                    <span
                      className="text-[10px] text-red-400"
                      title={verifyError}
                    >
                      {verifyError.slice(0, 50)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={verifyAllCandidates}
                    disabled={
                      verifying ||
                      candidates.every(
                        (c) => !c.email || !!c.verification,
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-40"
                    title="Run NeverBounce verification on every candidate (1 credit each)"
                  >
                    {verifying ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-3" />
                    )}
                    {verifying ? "Verifying…" : "Verify all"}
                  </button>
                </div>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto p-1.5">
                {candidates.map((c, i) => {
                  const v = c.verification;
                  const verifyBadge = v
                    ? (() => {
                        const map: Record<
                          VerificationStatus,
                          { label: string; className: string; title?: string }
                        > = {
                          valid: {
                            label: "valid",
                            className:
                              "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
                            title: "Mailbox exists — safe to send",
                          },
                          invalid: {
                            label: "invalid",
                            className:
                              "bg-red-500/15 text-red-300 border-red-500/30",
                            title: "Mailbox does not exist — will bounce",
                          },
                          catchall: {
                            label: "catchall",
                            className:
                              "bg-amber-500/15 text-amber-300 border-amber-500/30",
                            title:
                              "Domain accepts all mail — can't confirm specific mailbox",
                          },
                          disposable: {
                            label: "disposable",
                            className:
                              "bg-orange-500/15 text-orange-300 border-orange-500/30",
                            title: "Disposable email provider",
                          },
                          unknown: {
                            label: "unknown",
                            className:
                              "bg-neutral-500/15 text-neutral-400 border-neutral-500/30",
                            title:
                              "NeverBounce couldn't determine — try sending and watch bounces",
                          },
                          error: {
                            label: "error",
                            className:
                              "bg-neutral-700/30 text-neutral-500 border-white/10",
                            title: v.error ?? "Verification error",
                          },
                          config_missing: {
                            label: "no api key",
                            className:
                              "bg-neutral-700/30 text-neutral-500 border-white/10",
                            title:
                              "Set NEVERBOUNCE_API_KEY in Railway env vars",
                          },
                        };
                        return map[v.status];
                      })()
                    : null;
                  return (
                    <button
                      key={`${c.email ?? c.name}-${i}`}
                      type="button"
                      onClick={() => applyCandidate(c)}
                      className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition hover:bg-white/[0.04]"
                    >
                      <span className="mt-0.5">
                        {c.emailSource === "scraped" ? (
                          <CheckCircle2
                            className="size-3.5 text-emerald-400"
                            aria-label="Visible on page"
                          />
                        ) : (
                          <Sparkles
                            className="size-3.5 text-violet-400"
                            aria-label="Pattern guess"
                          />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-neutral-200">
                          <span className="font-medium">{c.name}</span>
                          {c.role && (
                            <span className="text-[10px] text-neutral-500">
                              {c.role}
                            </span>
                          )}
                        </div>
                        {c.email && (
                          <div className="font-mono text-[11px] text-neutral-300">
                            {c.email}
                          </div>
                        )}
                        {c.notes && (
                          <div className="text-[10px] text-neutral-600">
                            {c.notes}
                          </div>
                        )}
                        {v?.suggestedCorrection && (
                          <div
                            className="text-[10px] text-amber-400"
                            title="NeverBounce suggested correction"
                          >
                            → {v.suggestedCorrection}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {verifyBadge && (
                          <span
                            className={cn(
                              "rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                              verifyBadge.className,
                            )}
                            title={verifyBadge.title}
                          >
                            {verifyBadge.label}
                          </span>
                        )}
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                            c.emailConfidence === "high" ||
                              c.emailConfidence === "verified"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : c.emailConfidence === "medium"
                                ? "bg-amber-500/15 text-amber-300"
                                : c.emailConfidence === "low"
                                  ? "bg-neutral-500/15 text-neutral-400"
                                  : "bg-neutral-700/30 text-neutral-500",
                          )}
                        >
                          {c.emailConfidence ?? "no email"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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
