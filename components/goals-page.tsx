"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Target,
  Plus,
  Minus,
  Loader2,
  RefreshCw,
  Trash2,
  Check,
  ChevronDown,
  Search,
  Link2,
  X,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import {
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  currentMonthRange,
  currentWeekRange,
  type Goal,
  type GoalPriority,
  type GoalStatus,
  type LinkedWorkItem,
} from "@/lib/goals";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
// Constants
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<GoalStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-violet-500/20 text-violet-300" },
  completed: {
    label: "Completed",
    className: "bg-emerald-500/20 text-emerald-300",
  },
  missed: { label: "Missed", className: "bg-red-500/20 text-red-300" },
  paused: { label: "Paused", className: "bg-amber-500/20 text-amber-300" },
  archived: {
    label: "Archived",
    className: "bg-neutral-700/30 text-neutral-500",
  },
};

const PRIORITY_BADGE: Record<GoalPriority, string> = {
  high: "bg-red-500/15 text-red-300 border-red-500/30",
  medium: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  low: "bg-neutral-500/15 text-neutral-400 border-neutral-500/30",
};

const SCOPE_LABELS: Record<string, string> = {
  current: "This period",
  upcoming: "Upcoming",
  past: "Past",
  all: "All",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TeamMember = { email: string; label: string };

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmtRange(start: string, end: string): string {
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

function daysLeft(end: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(0, 0, 0, 0);
  return Math.ceil((e.getTime() - today.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GoalsPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<
    "current" | "upcoming" | "past" | "all"
  >("current");
  const [statusFilter, setStatusFilter] = useState<GoalStatus | "all">("all");
  const [responsibleFilter, setResponsibleFilter] = useState<string>("all");
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

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

  const fetchGoals = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("periodScope", scopeFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (responsibleFilter !== "all")
        params.set("responsibleEmail", responsibleFilter);
      const res = await fetch(`/api/goals?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed (${res.status})`);
      }
      const data = await res.json();
      setGoals(data.goals ?? []);
      setStats((data.stats?.byStatus as Record<string, number>) ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGoals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, scopeFilter, statusFilter, responsibleFilter]);

  const incrementGoal = async (id: string, delta: number) => {
    if (!token) return;
    // Optimistic
    setGoals((prev) =>
      prev.map((g) => {
        if (g.id !== id) return g;
        const current = Math.max(0, g.currentCount + delta);
        const status: GoalStatus =
          current >= g.targetCount && g.status === "active"
            ? "completed"
            : current < g.targetCount && g.status === "completed"
              ? "active"
              : g.status;
        return { ...g, currentCount: current, status };
      }),
    );
    try {
      const res = await fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ delta }),
      });
      if (!res.ok) throw new Error("Failed");
    } catch {
      fetchGoals();
    }
  };

  const updateInline = async (id: string, updates: Partial<Goal>) => {
    if (!token) return;
    setGoals((prev) => prev.map((g) => (g.id === id ? { ...g, ...updates } : g)));
    try {
      const res = await fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed");
    } catch {
      fetchGoals();
    }
  };

  const removeGoal = async (id: string) => {
    if (!token || !confirm("Delete this goal?")) return;
    try {
      const res = await fetch(`/api/goals/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed");
      setGoals((prev) => prev.filter((g) => g.id !== id));
    } catch {
      setError("Failed to delete");
    }
  };

  // Header summary based on what's loaded
  const totalProgress = goals.reduce(
    (acc, g) => acc + Math.min(g.currentCount, g.targetCount),
    0,
  );
  const totalTarget = goals.reduce((acc, g) => acc + g.targetCount, 0);
  const completed = goals.filter((g) => g.status === "completed").length;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Target className="h-6 w-6 text-violet-400" />
            Goals
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {goals.length === 0
              ? "No goals in this period — click Add goal to start"
              : `${completed} of ${goals.length} hit · ${totalProgress} / ${totalTarget} units delivered`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-300 transition hover:bg-violet-500/20"
          >
            <Plus className="h-4 w-4" />
            Add goal
          </button>
          <button
            onClick={fetchGoals}
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
          value={scopeFilter}
          onValueChange={(v) => setScopeFilter(v as typeof scopeFilter)}
        >
          <SelectTrigger className="h-9 w-36 border-white/10 bg-neutral-900 text-xs text-neutral-200">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
            {Object.entries(SCOPE_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
        >
          <SelectTrigger className="h-9 w-32 border-white/10 bg-neutral-900 text-xs text-neutral-200">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
            <SelectItem value="all">Any status ({stats.total ?? ""})</SelectItem>
            {GOAL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label} ({stats[s] || 0})
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
      </div>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {/* Goal list */}
      {loading && goals.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
        </div>
      ) : goals.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 bg-neutral-900/30 py-16 text-center">
          <Target className="h-10 w-10 text-neutral-700" />
          <p className="text-sm text-neutral-500">
            {scopeFilter === "current"
              ? "No goals for this period yet."
              : "No goals match these filters."}
          </p>
          <button
            onClick={() => setCreating(true)}
            className="mt-2 rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-500"
          >
            Add the first one
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              teamMembers={teamMembers}
              token={token}
              onIncrement={(delta) => incrementGoal(g.id, delta)}
              onUpdate={(updates) => updateInline(g.id, updates)}
              onEdit={() => setEditing(g)}
              onDelete={() => removeGoal(g.id)}
              onLinksChanged={(updated) =>
                setGoals((prev) =>
                  prev.map((it) => (it.id === updated.id ? updated : it)),
                )
              }
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {creating && (
        <GoalFormDialog
          mode="create"
          token={token}
          teamMembers={teamMembers}
          onClose={() => setCreating(false)}
          onSaved={(g) => {
            setGoals((prev) => [g, ...prev]);
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <GoalFormDialog
          mode="edit"
          token={token}
          teamMembers={teamMembers}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(g) => {
            setGoals((prev) => prev.map((it) => (it.id === g.id ? g : it)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Goal card
// ---------------------------------------------------------------------------

type WorkItemSummary = {
  id: string;
  title: string;
  itemType: string;
  stage: string | null;
  responsibleEmail: string | null;
};

function GoalCard({
  goal,
  teamMembers,
  token,
  onIncrement,
  onUpdate,
  onEdit,
  onDelete,
  onLinksChanged,
}: {
  goal: Goal;
  teamMembers: TeamMember[];
  token: string | null;
  onIncrement: (delta: number) => void;
  onUpdate: (updates: Partial<Goal>) => void;
  onEdit: () => void;
  onDelete: () => void;
  onLinksChanged: (goal: Goal) => void;
}) {
  const pct = Math.min(
    100,
    Math.round((goal.currentCount / goal.targetCount) * 100),
  );
  const status = STATUS_LABELS[goal.status];
  const priority = PRIORITY_BADGE[goal.priority];
  const remaining = daysLeft(goal.periodEnd);
  const progressColor =
    goal.status === "completed"
      ? "bg-emerald-500"
      : goal.status === "missed"
        ? "bg-red-500"
        : pct >= 75
          ? "bg-emerald-400"
          : pct >= 40
            ? "bg-violet-400"
            : "bg-violet-500/60";

  const [links, setLinks] = useState<LinkedWorkItem[]>([]);
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);

  const fetchLinks = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/goals/${goal.id}/links`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setLinks((data.links ?? []) as LinkedWorkItem[]);
      setLinksLoaded(true);
    } catch {
      // ignore
    }
  }, [goal.id, token]);

  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  const isAuto = links.length > 0;
  const linkedDone = links.filter((l) => l.isDone).length;

  const linkTask = async (workItemId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/goals/${goal.id}/links`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workItemId }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setLinks(data.links ?? []);
      if (data.goal) onLinksChanged(data.goal);
      setExpanded(true);
    } catch (err) {
      console.error("[goals] link failed:", err);
    }
  };

  const unlinkTask = async (workItemId: string) => {
    if (!token) return;
    try {
      const res = await fetch(
        `/api/goals/${goal.id}/links/${workItemId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setLinks(data.links ?? []);
      if (data.goal) onLinksChanged(data.goal);
    } catch (err) {
      console.error("[goals] unlink failed:", err);
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-neutral-900/60 p-4 transition hover:border-white/10">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                priority,
              )}
            >
              {goal.priority}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                status.className,
              )}
            >
              {status.label}
            </span>
            {isAuto && (
              <span
                className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300"
                title="Progress is auto-computed from linked tasks"
              >
                Auto · {linkedDone}/{links.length} done
              </span>
            )}
            <h3
              className="cursor-pointer text-sm font-semibold leading-snug text-white hover:underline"
              onClick={onEdit}
            >
              {goal.title}
            </h3>
            {goal.unit && (
              <span className="text-[11px] text-neutral-500">
                · {goal.unit}
              </span>
            )}
          </div>
          {goal.description && (
            <p className="mt-1 text-xs text-neutral-400">{goal.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-neutral-500">
            <span>{fmtRange(goal.periodStart, goal.periodEnd)}</span>
            <span>·</span>
            <span
              className={cn(
                remaining < 0 && goal.status === "active" && "text-red-400",
                remaining >= 0 && remaining <= 2 && "text-amber-400",
              )}
            >
              {remaining < 0
                ? `${Math.abs(remaining)}d overdue`
                : remaining === 0
                  ? "ends today"
                  : `${remaining}d left`}
            </span>
            {goal.responsibleEmail && (
              <>
                <span>·</span>
                <Select
                  value={goal.responsibleEmail}
                  onValueChange={(v) =>
                    onUpdate({
                      responsibleEmail:
                        v === "__unassigned__" ? null : (v as string),
                    })
                  }
                >
                  <SelectTrigger className="h-5 border-none bg-transparent px-1 text-[10px] text-neutral-300 hover:bg-white/5 focus:ring-0">
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
              </>
            )}
            {goal.projectRef && (
              <>
                <span>·</span>
                <span className="text-neutral-500">{goal.projectRef}</span>
              </>
            )}
          </div>
        </div>

        {/* Progress + counter — manual when no links, auto-display when linked */}
        <div
          className={cn(
            "flex items-center gap-2",
            isAuto && "opacity-80",
          )}
          title={
            isAuto
              ? "Auto-computed from linked tasks. Unlink all to switch back to manual."
              : ""
          }
        >
          <button
            onClick={() => !isAuto && onIncrement(-1)}
            disabled={isAuto || goal.currentCount <= 0}
            className="rounded-md border border-white/10 bg-white/5 p-1.5 text-neutral-400 transition hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-white/5"
            aria-label="Decrement"
          >
            <Minus className="size-3.5" />
          </button>
          <div className="min-w-[72px] text-center">
            <div className="text-lg font-semibold text-white">
              {goal.currentCount}
              <span className="text-neutral-500"> / {goal.targetCount}</span>
            </div>
            <div className="text-[10px] text-neutral-600">{pct}%</div>
          </div>
          <button
            onClick={() => !isAuto && onIncrement(1)}
            disabled={isAuto}
            className="rounded-md border border-violet-500/30 bg-violet-500/10 p-1.5 text-violet-300 transition hover:bg-violet-500/20 disabled:opacity-40 disabled:hover:bg-violet-500/10"
            aria-label="Increment"
          >
            <Plus className="size-3.5" />
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <button
            onClick={onEdit}
            className="rounded p-1 text-neutral-500 transition hover:bg-white/10 hover:text-neutral-200"
            title="Edit"
            aria-label="Edit goal"
          >
            <Check className="size-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="rounded p-1 text-neutral-700 transition hover:bg-red-500/10 hover:text-red-400"
            title="Delete"
            aria-label="Delete goal"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
        <div
          className={cn("h-full transition-all duration-300", progressColor)}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Linked tasks */}
      <div className="mt-3 border-t border-white/[0.04] pt-2">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center gap-1.5 text-[11px] text-neutral-500 hover:text-neutral-300"
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              expanded ? "rotate-0" : "-rotate-90",
            )}
          />
          <Link2 className="size-3" />
          <span>
            {linksLoaded ? `${links.length} linked task${links.length === 1 ? "" : "s"}` : "Linked tasks"}
          </span>
          <span
            className="ml-auto inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white"
            onClick={(e) => {
              e.stopPropagation();
              setPicking(true);
              setExpanded(true);
            }}
          >
            <Plus className="size-2.5" />
            Link
          </span>
        </button>
        {expanded && links.length > 0 && (
          <div className="mt-2 space-y-1">
            {links.map((l) => (
              <div
                key={l.id}
                className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/[0.03]"
              >
                <span
                  className={cn(
                    "flex size-3.5 shrink-0 items-center justify-center rounded-full border text-[8px]",
                    l.isDone
                      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                      : "border-white/10 bg-white/5 text-neutral-500",
                  )}
                  title={l.isDone ? "Done" : `Stage: ${l.stage ?? "—"}`}
                >
                  {l.isDone ? "✓" : ""}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12px]",
                    l.isDone ? "text-neutral-300" : "text-neutral-200",
                  )}
                  title={l.title}
                >
                  {l.title}
                </span>
                <span className="shrink-0 text-[10px] text-neutral-600">
                  {l.itemType} · {l.stage ?? "—"}
                </span>
                <button
                  onClick={() => unlinkTask(l.id)}
                  className="opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                  aria-label="Unlink task"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {picking && (
        <TaskPickerDialog
          token={token}
          existingIds={new Set(links.map((l) => l.id))}
          onClose={() => setPicking(false)}
          onSelect={async (id) => {
            await linkTask(id);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

// Picker dialog — search the kanban board and link a task to the current
// goal. Existing links are filtered out so the same task can't be linked
// twice.
function TaskPickerDialog({
  token,
  existingIds,
  onClose,
  onSelect,
}: {
  token: string | null;
  existingIds: Set<string>;
  onClose: () => void;
  onSelect: (workItemId: string) => Promise<void>;
}) {
  const [items, setItems] = useState<WorkItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch("/api/kanban/items", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const list = (data?.items ?? []) as Array<{
          id: string;
          title: string;
          itemType: string;
          stage?: string | null;
          responsibleEmail?: string | null;
        }>;
        setItems(
          list.map((i) => ({
            id: i.id,
            title: i.title,
            itemType: i.itemType,
            stage: i.stage ?? null,
            responsibleEmail: i.responsibleEmail ?? null,
          })),
        );
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (existingIds.has(i.id)) return false;
      if (!q) return true;
      return i.title.toLowerCase().includes(q);
    });
  }, [items, query, existingIds]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[70vh] max-w-lg overflow-hidden border-white/10 bg-neutral-950 p-0 text-neutral-100">
        <DialogHeader className="border-b border-white/10 px-4 py-3">
          <DialogTitle className="text-sm">Link a task to this goal</DialogTitle>
        </DialogHeader>
        <div className="border-b border-white/10 px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-neutral-500" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title…"
              className="h-9 border-white/10 bg-neutral-900 pl-7 text-sm"
            />
          </div>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-4 animate-spin text-neutral-500" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">
              {items.length === 0
                ? "No tasks on the board yet."
                : query
                  ? "No tasks match that search."
                  : "All tasks are already linked."}
            </p>
          ) : (
            filtered.slice(0, 80).map((i) => (
              <button
                key={i.id}
                onClick={() => onSelect(i.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 transition hover:bg-white/5"
              >
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <span className="shrink-0 text-[10px] text-neutral-500">
                  {i.itemType}
                  {i.stage ? ` · ${i.stage}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Form dialog (create + edit)
// ---------------------------------------------------------------------------

function GoalFormDialog({
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
  initial?: Goal;
  onClose: () => void;
  onSaved: (g: Goal) => void;
}) {
  const week = currentWeekRange();
  const month = currentMonthRange();

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [unit, setUnit] = useState(initial?.unit ?? "");
  const [target, setTarget] = useState<string>(
    String(initial?.targetCount ?? 1),
  );
  const [current, setCurrent] = useState<string>(
    String(initial?.currentCount ?? 0),
  );
  const [periodStart, setPeriodStart] = useState(
    initial?.periodStart ?? week.start,
  );
  const [periodEnd, setPeriodEnd] = useState(initial?.periodEnd ?? week.end);
  const [status, setStatus] = useState<GoalStatus>(initial?.status ?? "active");
  const [priority, setPriority] = useState<GoalPriority>(
    initial?.priority ?? "medium",
  );
  const [responsibleEmail, setResponsibleEmail] = useState(
    initial?.responsibleEmail ?? "",
  );
  const [projectRef, setProjectRef] = useState(initial?.projectRef ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setQuickPeriod = (kind: "week" | "month") => {
    if (kind === "week") {
      setPeriodStart(week.start);
      setPeriodEnd(week.end);
    } else {
      setPeriodStart(month.start);
      setPeriodEnd(month.end);
    }
  };

  const handleSubmit = async () => {
    if (!token) return;
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        unit: unit.trim() || null,
        targetCount: Math.max(1, Number(target) || 1),
        currentCount: Math.max(0, Number(current) || 0),
        periodStart,
        periodEnd,
        status,
        priority,
        responsibleEmail: responsibleEmail || null,
        projectRef: projectRef.trim() || null,
        notes: notes.trim() || null,
      };
      const url =
        mode === "create" ? "/api/goals" : `/api/goals/${initial?.id}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed");
      onSaved(data.goal);
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
            {mode === "create" ? "Add goal" : "Edit goal"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Title *">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ship 5 /alternative pages"
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this matters / what's in scope"
              rows={2}
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Target *">
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                inputMode="numeric"
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
            <Field label="Current">
              <Input
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                inputMode="numeric"
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
            <Field label="Unit">
              <Input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="articles"
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </Field>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2">
              <label className="text-[11px] uppercase tracking-wider text-neutral-500">
                Period
              </label>
              <button
                type="button"
                onClick={() => setQuickPeriod("week")}
                className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-white"
              >
                This week
              </button>
              <button
                type="button"
                onClick={() => setQuickPeriod("month")}
                className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-white"
              >
                This month
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="border-white/10 bg-neutral-900 text-sm"
              />
              <Input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="border-white/10 bg-neutral-900 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Status">
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as GoalStatus)}
              >
                <SelectTrigger className="border-white/10 bg-neutral-900 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                  {GOAL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority">
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as GoalPriority)}
              >
                <SelectTrigger className="border-white/10 bg-neutral-900 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                  {GOAL_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          <Field label="Project (optional)">
            <Input
              value={projectRef}
              onChange={(e) => setProjectRef(e.target.value)}
              placeholder="e.g. 12-guest-post-pipeline"
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
          <Field label="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Acceptance criteria, blockers, etc."
              rows={3}
              className="border-white/10 bg-neutral-900 text-sm"
            />
          </Field>
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
            disabled={saving || !title.trim()}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
          >
            {saving
              ? "Saving…"
              : mode === "create"
                ? "Add goal"
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
