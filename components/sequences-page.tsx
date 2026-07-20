"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Linkedin,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
  Users,
  Workflow,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── Types ──────────────────────────────────────────────────────────

type Sequence = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  stepCount?: number;
  enrollmentCount?: number;
};

type StepDraft = {
  key: string;
  channel: "email" | "linkedin";
  mode: "auto" | "semi";
  delayHours: number;
  linkedinAction: "connect_note" | "message" | null;
  subjectTemplate: string;
  bodyTemplate: string;
};

type QueueTask = {
  id: string;
  channel: string;
  mode: string;
  status: string;
  renderedBody: string | null;
  renderedSubject: string | null;
  scheduledFor?: string;
  meta: Record<string, unknown>;
  sequenceName?: string | null;
  enrollment?: {
    companyName: string;
    domain: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactLinkedin: string | null;
    contactRole: string | null;
  };
  step?: { linkedinAction: string | null; position: number };
};

type ActivityStats = {
  readyLinkedin: number;
  readyEmail: number;
  readyTotal: number;
  sentToday: number;
  skippedToday: number;
  emailAutoSend: boolean;
};

type ResearchTable = { id: string; name: string; slug?: string | null };

// ── Helpers ────────────────────────────────────────────────────────

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);
  return token;
}

function newKey() {
  return `s_${Math.random().toString(36).slice(2, 10)}`;
}

function formatWait(hours: number): string {
  if (hours <= 0) return "Immediately";
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return d === 1 ? "1 day" : `${d} days`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

function blankStep(channel: "email" | "linkedin"): StepDraft {
  if (channel === "email") {
    return {
      key: newKey(),
      channel: "email",
      mode: "auto",
      delayHours: 24,
      linkedinAction: null,
      subjectTemplate: "Quick note for {{company}}",
      bodyTemplate: `Hi {{first_name}},

Noticed {{company}} is investing in quality. Worth a quick chat?

— Kodus`,
    };
  }
  return {
    key: newKey(),
    channel: "linkedin",
    mode: "semi",
    delayHours: 0,
    linkedinAction: "connect_note",
    subjectTemplate: "",
    bodyTemplate:
      "Hey {{first_name}} — saw {{company}} is hiring for QA. Open to a quick chat?",
  };
}

function mapApiStep(s: Record<string, unknown>): StepDraft {
  const channel = s.channel === "email" ? "email" : "linkedin";
  const action = String(
    s.linkedinAction ?? s.linkedin_action ?? "message",
  ) as "connect_note" | "message";
  return {
    key: newKey(),
    channel,
    mode:
      channel === "linkedin"
        ? "semi"
        : s.mode === "semi"
          ? "semi"
          : "auto",
    delayHours: Number(s.delayHours ?? s.delay_hours ?? 0),
    linkedinAction: channel === "linkedin" ? action : null,
    subjectTemplate: String(s.subjectTemplate ?? s.subject_template ?? ""),
    bodyTemplate: String(s.bodyTemplate ?? s.body_template ?? ""),
  };
}

function stepTitle(s: StepDraft): string {
  if (s.channel === "linkedin") {
    return s.linkedinAction === "connect_note"
      ? "Connection request"
      : "LinkedIn message";
  }
  return s.mode === "auto" ? "Auto email" : "Manual email";
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-emerald-500"
      : status === "paused"
        ? "bg-amber-500"
        : status === "archived"
          ? "bg-neutral-500"
          : "bg-sky-500";
  return <span className={cn("inline-block size-1.5 rounded-full", color)} />;
}

// ── Segmented control ──────────────────────────────────────────────

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────

export function SequencesPage() {
  const token = useAuthToken();
  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const [view, setView] = useState<"list" | "queue" | "editor">("queue");
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [activityFilter, setActivityFilter] = useState<
    "all" | "linkedin" | "email"
  >("all");
  const [tables, setTables] = useState<ResearchTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mailboxConfigured, setMailboxConfigured] = useState(true);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState("draft");
  const [editSteps, setEditSteps] = useState<StepDraft[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enrollmentCount, setEnrollmentCount] = useState(0);
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [enrollTableId, setEnrollTableId] = useState("");
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [seqRes, queueRes, tablesRes] = await Promise.all([
        fetch("/api/outreach/sequences", { headers: headers() }),
        fetch("/api/outreach/sequences/queue", {
          headers: headers(),
        }),
        fetch("/api/research/tables", { headers: headers() }),
      ]);
      if (seqRes.ok) {
        const d = await seqRes.json();
        setSequences(d.sequences ?? []);
        setMailboxConfigured(Boolean(d.mailboxConfigured));
      }
      if (queueRes.ok) {
        const d = await queueRes.json();
        setTasks(d.tasks ?? []);
        setStats(d.stats ?? null);
      }
      if (tablesRes.ok) {
        const d = await tablesRes.json();
        setTables(d.tables ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = async (id: string) => {
    if (!token) return;
    setEditingId(id);
    setView("editor");
    setEditLoading(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${id}`, {
        headers: headers(),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load");
        setView("list");
        setEditingId(null);
        return;
      }
      setEditName(data.sequence?.name ?? "");
      setEditDescription(data.sequence?.description ?? "");
      setEditStatus(data.sequence?.status ?? "draft");
      setEnrollmentCount((data.enrollments as unknown[])?.length ?? 0);
      const steps = ((data.steps ?? []) as Record<string, unknown>[]).map(
        mapApiStep,
      );
      const next = steps.length ? steps : [blankStep("linkedin")];
      setEditSteps(next);
      setSelectedStepKey(next[0]?.key ?? null);
    } finally {
      setEditLoading(false);
    }
  };

  const createSeq = async () => {
    if (!token || !newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/outreach/sequences", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create");
        return;
      }
      setCreateOpen(false);
      setNewName("");
      await load();
      if (data.sequence?.id) await openEditor(data.sequence.id);
    } finally {
      setCreating(false);
    }
  };

  const saveSequence = async () => {
    if (!token || !editingId) return;
    if (!editName.trim()) {
      setError("Name is required");
      return;
    }
    if (editSteps.length === 0) {
      setError("Add at least one step");
      return;
    }
    for (let i = 0; i < editSteps.length; i++) {
      const s = editSteps[i];
      if (!s.bodyTemplate.trim()) {
        setError(`Step ${i + 1}: message is empty`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
          status: editStatus,
          steps: editSteps.map((s) => ({
            channel: s.channel,
            mode: s.channel === "linkedin" ? "semi" : s.mode,
            delayHours: Number(s.delayHours) || 0,
            linkedinAction:
              s.channel === "linkedin" ? s.linkedinAction : null,
            subjectTemplate:
              s.channel === "email" ? s.subjectTemplate || null : null,
            bodyTemplate: s.bodyTemplate,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setNotice("Saved");
      await load();
      if (data.steps) {
        const mapped = (data.steps as Record<string, unknown>[]).map(
          mapApiStep,
        );
        setEditSteps(mapped);
        setSelectedStepKey((k) =>
          mapped.some((m) => m.key === k) ? k : mapped[0]?.key ?? null,
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const updateStep = (key: string, patch: Partial<StepDraft>) => {
    setEditSteps((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s;
        const next = { ...s, ...patch };
        if (patch.channel === "linkedin") {
          next.mode = "semi";
          next.linkedinAction = next.linkedinAction ?? "connect_note";
          next.subjectTemplate = "";
        }
        if (patch.channel === "email") {
          next.mode = next.mode === "semi" ? "semi" : "auto";
          next.linkedinAction = null;
          if (!next.subjectTemplate) {
            next.subjectTemplate = "Quick note for {{company}}";
          }
        }
        return next;
      }),
    );
  };

  const enroll = async () => {
    if (!token || !enrollSeqId || !enrollTableId) return;
    setEnrolling(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/outreach/sequences/${enrollSeqId}/enroll`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            source: "research",
            table_ref: enrollTableId,
            all_people: true,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Enroll failed");
        return;
      }
      setEnrollOpen(false);
      setNotice(
        `Enrolled ${data.enrolled} · skipped ${data.skipped}`,
      );
      setView("queue");
      setEditingId(null);
      await load();
    } finally {
      setEnrolling(false);
    }
  };

  const complete = async (taskId: string, outcome: "sent" | "skipped") => {
    if (!token) return;
    setBusyId(taskId);
    try {
      const res = await fetch(
        `/api/outreach/sequences/tasks/${taskId}/complete`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ outcome }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed");
        return;
      }
      setNotice(outcome === "sent" ? "Marked sent" : "Skipped");
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied");
    } catch {
      setError("Could not copy");
    }
  };

  const openEmailCompose = (t: QueueTask) => {
    const to = t.enrollment?.contactEmail ?? "";
    const subject = t.renderedSubject ?? "";
    const body = t.renderedBody ?? "";
    const gmail = new URL("https://mail.google.com/mail/");
    gmail.searchParams.set("view", "cm");
    gmail.searchParams.set("fs", "1");
    if (to) gmail.searchParams.set("to", to);
    if (subject) gmail.searchParams.set("su", subject);
    if (body) gmail.searchParams.set("body", body);
    window.open(gmail.toString(), "_blank", "noopener,noreferrer");
  };

  const filteredTasks = useMemo(() => {
    if (activityFilter === "all") return tasks;
    return tasks.filter((t) => t.channel === activityFilter);
  }, [tasks, activityFilter]);

  const activityLabel = (t: QueueTask) => {
    if (t.channel === "linkedin") {
      return t.step?.linkedinAction === "connect_note"
        ? "Send LinkedIn connection"
        : "Send LinkedIn message";
    }
    return t.mode === "auto" || t.meta?.auto_send_disabled
      ? "Send email (manual)"
      : "Send email";
  };

  if (!token) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════
  // EDITOR — Instantly-style vertical timeline
  // ════════════════════════════════════════════════════════════════
  if (view === "editor" && editingId) {
    const selected =
      editSteps.find((s) => s.key === selectedStepKey) ?? editSteps[0];

    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* Sticky top bar */}
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2"
              onClick={() => {
                setView("list");
                setEditingId(null);
                void load();
              }}
            >
              <ArrowLeft className="size-3.5" />
              Sequences
            </Button>
            <div className="hidden h-4 w-px bg-border sm:block" />
            <div className="min-w-0 flex-1">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-8 border-transparent bg-transparent px-1 text-base font-semibold shadow-none focus-visible:border-border focus-visible:bg-background"
                placeholder="Sequence name"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select value={editStatus} onValueChange={setEditStatus}>
                <SelectTrigger className="h-8 w-[120px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEnrollSeqId(editingId);
                  setEnrollOpen(true);
                }}
              >
                <Users className="size-3.5" />
                Enroll
              </Button>
              <Button size="sm" disabled={saving} onClick={() => void saveSequence()}>
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Save
              </Button>
            </div>
          </div>
          {(notice || error) && (
            <div className="mx-auto mt-2 max-w-6xl">
              {notice && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  {notice}
                </p>
              )}
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
            </div>
          )}
        </header>

        {editLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading sequence…
          </div>
        ) : (
          <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_340px]">
            {/* Timeline column */}
            <div className="min-h-0 overflow-y-auto border-r border-border px-4 py-6 sm:px-6">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {editSteps.length} step{editSteps.length === 1 ? "" : "s"}
                    {enrollmentCount > 0
                      ? ` · ${enrollmentCount} enrolled`
                      : ""}
                    {!mailboxConfigured ? " · connect Gmail in Settings" : ""}
                  </p>
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Add a short description…"
                    className="mt-1 h-8 border-transparent bg-transparent px-0 text-sm text-muted-foreground shadow-none focus-visible:border-border focus-visible:bg-background focus-visible:px-2"
                  />
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const s = blankStep("linkedin");
                      setEditSteps((p) => [...p, s]);
                      setSelectedStepKey(s.key);
                    }}
                  >
                    <Linkedin className="size-3.5" />
                    LinkedIn
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const s = blankStep("email");
                      setEditSteps((p) => [...p, s]);
                      setSelectedStepKey(s.key);
                    }}
                  >
                    <Mail className="size-3.5" />
                    Email
                  </Button>
                </div>
              </div>

              <div className="relative space-y-0">
                {editSteps.map((step, idx) => {
                  const isSelected = selected?.key === step.key;
                  const waitDays = Math.floor(step.delayHours / 24);
                  const waitHours = step.delayHours % 24;

                  return (
                    <div key={step.key}>
                      {/* Wait connector */}
                      {idx > 0 && (
                        <div className="flex items-center gap-3 py-2 pl-5">
                          <div className="flex w-8 justify-center">
                            <div className="h-6 w-px bg-border" />
                          </div>
                          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                            <Clock className="size-3" />
                            Wait {formatWait(step.delayHours).toLowerCase()}
                          </div>
                        </div>
                      )}

                      <div className="flex gap-3">
                        {/* Rail */}
                        <div className="flex w-8 flex-col items-center pt-3">
                          <div
                            className={cn(
                              "flex size-8 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                              isSelected
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-card text-muted-foreground",
                            )}
                          >
                            {idx + 1}
                          </div>
                          {idx < editSteps.length - 1 && (
                            <div className="mt-1 w-px flex-1 bg-border" />
                          )}
                        </div>

                        {/* Card */}
                        <button
                          type="button"
                          onClick={() => setSelectedStepKey(step.key)}
                          className={cn(
                            "mb-1 min-w-0 flex-1 rounded-xl border p-4 text-left transition-colors",
                            isSelected
                              ? "border-foreground/20 bg-card shadow-sm ring-1 ring-foreground/10"
                              : "border-border bg-card/50 hover:border-foreground/15 hover:bg-card",
                          )}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "flex size-7 items-center justify-center rounded-md",
                                  step.channel === "linkedin"
                                    ? "bg-[#0A66C2]/15 text-[#0A66C2]"
                                    : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                                )}
                              >
                                {step.channel === "linkedin" ? (
                                  <Linkedin className="size-3.5" />
                                ) : (
                                  <Mail className="size-3.5" />
                                )}
                              </span>
                              <div>
                                <p className="text-sm font-medium text-balance">
                                  {stepTitle(step)}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  {idx === 0
                                    ? "Starts on enroll"
                                    : `After previous · ${formatWait(step.delayHours).toLowerCase()}`}
                                  {step.channel === "linkedin"
                                    ? " · you send"
                                    : step.mode === "auto"
                                      ? " · auto-send"
                                      : " · manual"}
                                </p>
                              </div>
                            </div>
                          </div>
                          <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                            {step.channel === "email" && step.subjectTemplate
                              ? `${step.subjectTemplate} — `
                              : ""}
                            {step.bodyTemplate || "Empty message…"}
                          </p>
                        </button>
                      </div>

                      {/* Expanded editor when selected */}
                      {isSelected && (
                        <div className="ml-11 mt-2 mb-4 space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Segmented
                              value={step.channel}
                              onChange={(v) =>
                                updateStep(step.key, { channel: v })
                              }
                              options={[
                                {
                                  value: "linkedin" as const,
                                  label: "LinkedIn",
                                  icon: <Linkedin className="size-3" />,
                                },
                                {
                                  value: "email" as const,
                                  label: "Email",
                                  icon: <Mail className="size-3" />,
                                },
                              ]}
                            />
                            <div className="flex gap-0.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="size-8 p-0"
                                disabled={idx === 0}
                                aria-label="Move up"
                                onClick={() =>
                                  setEditSteps((prev) => {
                                    if (idx === 0) return prev;
                                    const n = [...prev];
                                    [n[idx - 1], n[idx]] = [n[idx], n[idx - 1]];
                                    return n;
                                  })
                                }
                              >
                                <ArrowUp className="size-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="size-8 p-0"
                                disabled={idx === editSteps.length - 1}
                                aria-label="Move down"
                                onClick={() =>
                                  setEditSteps((prev) => {
                                    if (idx >= prev.length - 1) return prev;
                                    const n = [...prev];
                                    [n[idx], n[idx + 1]] = [n[idx + 1], n[idx]];
                                    return n;
                                  })
                                }
                              >
                                <ArrowDown className="size-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="size-8 p-0 text-muted-foreground hover:text-destructive"
                                disabled={editSteps.length <= 1}
                                aria-label="Remove step"
                                onClick={() => {
                                  setEditSteps((p) => {
                                    const next = p.filter(
                                      (x) => x.key !== step.key,
                                    );
                                    setSelectedStepKey(next[0]?.key ?? null);
                                    return next;
                                  });
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </div>

                          {step.channel === "linkedin" ? (
                            <div className="space-y-1.5">
                              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                Action
                              </p>
                              <Segmented
                                value={step.linkedinAction ?? "connect_note"}
                                onChange={(v) =>
                                  updateStep(step.key, {
                                    linkedinAction: v,
                                  })
                                }
                                options={[
                                  {
                                    value: "connect_note" as const,
                                    label: "Add connection + note",
                                  },
                                  {
                                    value: "message" as const,
                                    label: "Message",
                                  },
                                ]}
                              />
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                Delivery
                              </p>
                              <Segmented
                                value={step.mode}
                                onChange={(v) =>
                                  updateStep(step.key, { mode: v })
                                }
                                options={[
                                  {
                                    value: "auto" as const,
                                    label: "Auto-send",
                                  },
                                  {
                                    value: "semi" as const,
                                    label: "Manual queue",
                                  },
                                ]}
                              />
                            </div>
                          )}

                          <div className="space-y-1.5">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                              Wait before this step
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1">
                                <Input
                                  type="number"
                                  min={0}
                                  className="h-7 w-14 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
                                  value={waitDays}
                                  onChange={(e) =>
                                    updateStep(step.key, {
                                      delayHours:
                                        Math.max(0, Number(e.target.value) || 0) *
                                          24 +
                                        waitHours,
                                    })
                                  }
                                />
                                <span className="text-xs text-muted-foreground">
                                  days
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1">
                                <Input
                                  type="number"
                                  min={0}
                                  max={23}
                                  className="h-7 w-14 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
                                  value={waitHours}
                                  onChange={(e) =>
                                    updateStep(step.key, {
                                      delayHours:
                                        waitDays * 24 +
                                        Math.max(0, Number(e.target.value) || 0),
                                    })
                                  }
                                />
                                <span className="text-xs text-muted-foreground">
                                  hrs
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {(
                                  [
                                    [0, "Now"],
                                    [24, "1d"],
                                    [48, "2d"],
                                    [72, "3d"],
                                    [168, "1w"],
                                  ] as const
                                ).map(([h, label]) => (
                                  <button
                                    key={h}
                                    type="button"
                                    onClick={() =>
                                      updateStep(step.key, {
                                        delayHours: h,
                                      })
                                    }
                                    className={cn(
                                      "rounded-md px-2 py-1 text-[11px] font-medium",
                                      step.delayHours === h
                                        ? "bg-foreground text-background"
                                        : "bg-muted text-muted-foreground hover:text-foreground",
                                    )}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          {step.channel === "email" && (
                            <div className="space-y-1.5">
                              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                Subject
                              </p>
                              <Input
                                value={step.subjectTemplate}
                                onChange={(e) =>
                                  updateStep(step.key, {
                                    subjectTemplate: e.target.value,
                                  })
                                }
                                placeholder="Subject line…"
                                className="text-sm"
                              />
                            </div>
                          )}

                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                {step.channel === "linkedin"
                                  ? step.linkedinAction === "connect_note"
                                    ? "Connection note"
                                    : "Message"
                                  : "Body"}
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {"{{first_name}} {{company}} {{role}}"}
                              </p>
                            </div>
                            <Textarea
                              value={step.bodyTemplate}
                              onChange={(e) =>
                                updateStep(step.key, {
                                  bodyTemplate: e.target.value,
                                })
                              }
                              rows={step.channel === "email" ? 9 : 5}
                              className="min-h-[120px] resize-y text-sm leading-relaxed"
                              placeholder="Write the message…"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Add step footer */}
                <div className="flex items-center gap-3 pt-4 pl-0">
                  <div className="flex w-8 justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        const s = blankStep("linkedin");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                      className="flex size-8 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                      aria-label="Add step"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Add another step to the cadence
                  </p>
                </div>
              </div>
            </div>

            {/* Right: live preview */}
            <aside className="hidden min-h-0 overflow-y-auto bg-muted/20 p-5 lg:block">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Preview
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                How it looks with sample data
              </p>
              {selected && (
                <div className="mt-4 rounded-xl border border-border bg-background p-4 shadow-sm">
                  <div className="mb-3 flex items-center gap-2">
                    {selected.channel === "linkedin" ? (
                      <Linkedin className="size-4 text-[#0A66C2]" />
                    ) : (
                      <Mail className="size-4 text-amber-600" />
                    )}
                    <span className="text-xs font-medium">
                      {stepTitle(selected)}
                    </span>
                  </div>
                  {selected.channel === "email" && (
                    <p className="mb-2 border-b border-border pb-2 text-sm font-medium">
                      {selected.subjectTemplate
                        .replace(/\{\{\s*first_name\s*\}\}/gi, "Alex")
                        .replace(/\{\{\s*company\s*\}\}/gi, "Acme QA")
                        .replace(/\{\{\s*role\s*\}\}/gi, "Head of QA")
                        .replace(/\{\{\s*full_name\s*\}\}/gi, "Alex Chen")
                        .replace(/\{\{\s*domain\s*\}\}/gi, "acme.com") ||
                        "(no subject)"}
                    </p>
                  )}
                  <pre className="whitespace-pre-wrap text-sm leading-relaxed text-pretty text-foreground/90">
                    {selected.bodyTemplate
                      .replace(/\{\{\s*first_name\s*\}\}/gi, "Alex")
                      .replace(/\{\{\s*company\s*\}\}/gi, "Acme QA")
                      .replace(/\{\{\s*role\s*\}\}/gi, "Head of QA")
                      .replace(/\{\{\s*full_name\s*\}\}/gi, "Alex Chen")
                      .replace(/\{\{\s*domain\s*\}\}/gi, "acme.com")
                      .replace(/\{\{\s*email\s*\}\}/gi, "alex@acme.com")
                      .replace(
                        /\{\{\s*linkedin\s*\}\}/gi,
                        "linkedin.com/in/alex",
                      ) || "Empty…"}
                  </pre>
                  {selected.channel === "linkedin" && (
                    <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
                      {selected.linkedinAction === "connect_note"
                        ? "Queue: open LinkedIn → paste note → send connection request → Mark sent."
                        : "Queue: open LinkedIn → paste message → send DM → Mark sent."}
                    </p>
                  )}
                  {selected.channel === "email" && selected.mode === "auto" && (
                    <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
                      Sends automatically from the Gmail connected in Settings.
                    </p>
                  )}
                </div>
              )}

              <div className="mt-6">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Cadence
                </p>
                <ol className="mt-2 space-y-2">
                  {editSteps.map((s, i) => (
                    <li key={s.key} className="flex gap-2 text-xs">
                      <span className="tabular-nums text-muted-foreground">
                        {i + 1}.
                      </span>
                      <span className="text-pretty">
                        <span className="font-medium text-foreground">
                          {stepTitle(s)}
                        </span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {formatWait(s.delayHours).toLowerCase()}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </aside>
          </div>
        )}

        <EnrollDialog
          open={enrollOpen}
          onOpenChange={setEnrollOpen}
          sequences={sequences}
          tables={tables}
          enrollSeqId={enrollSeqId}
          setEnrollSeqId={setEnrollSeqId}
          enrollTableId={enrollTableId}
          setEnrollTableId={setEnrollTableId}
          enrolling={enrolling}
          onEnroll={() => void enroll()}
          hideSequencePick
        />
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════
  // LIST + QUEUE
  // ════════════════════════════════════════════════════════════════
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            Sequences
          </h1>
          <p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
            Today&apos;s outreach work first. Build cadences, enroll lists,
            execute LinkedIn + email from one board.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw
              className={cn("size-3.5", loading && "animate-spin")}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEnrollSeqId(sequences[0]?.id ?? "");
              setEnrollOpen(true);
            }}
          >
            <Users className="size-3.5" />
            Enroll
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New sequence
          </Button>
        </div>
      </div>

      {!mailboxConfigured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-pretty">
          Connect Gmail in{" "}
          <a href="/settings" className="font-medium underline underline-offset-2">
            Settings
          </a>{" "}
          so email steps can auto-send.
        </div>
      )}

      {(notice || error) && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            error
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-border bg-muted/40",
          )}
        >
          {error ?? notice}
        </div>
      )}

      {/* Tabs — Today first */}
      <div className="flex gap-1 border-b border-border">
        {(
          [
            [
              "queue",
              "Today",
              stats?.readyTotal ?? tasks.length,
              Check,
            ],
            ["list", "Sequences", sequences.length, Workflow],
          ] as const
        ).map(([id, label, count, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={cn(
              "inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors",
              view === id
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                view === id ? "bg-foreground/10" : "bg-muted",
              )}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {view === "list" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-auto pb-8">
          {loading && sequences.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Loading…
            </div>
          ) : sequences.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                <Workflow className="size-5 text-muted-foreground" />
              </div>
              <p className="mt-4 text-sm font-medium">No sequences yet</p>
              <p className="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">
                Create a cadence with LinkedIn and email steps, then enroll a
                research list.
              </p>
              <Button className="mt-5" onClick={() => setCreateOpen(true)}>
                <Plus className="size-3.5" />
                New sequence
              </Button>
            </div>
          ) : (
            sequences.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => void openEditor(s.id)}
                className="group flex w-full items-stretch gap-0 overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-foreground/20 hover:bg-card/80"
              >
                <div className="flex w-1 shrink-0 bg-border group-hover:bg-foreground/30" />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4 px-4 py-4 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold">
                        {s.name}
                      </p>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                        <StatusDot status={s.status} />
                        {s.status}
                      </span>
                    </div>
                    {s.description && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {s.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Workflow className="size-3" />
                        {s.stepCount ?? 0} steps
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="size-3" />
                        {s.enrollmentCount ?? 0} active
                      </span>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">
                    Open →
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {view === "queue" && (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto pb-8">
          {/* Day summary */}
          <div className="grid gap-2 sm:grid-cols-4">
            {(
              [
                {
                  label: "To do now",
                  value: stats?.readyTotal ?? tasks.length,
                  hint: "Ready for you",
                },
                {
                  label: "LinkedIn",
                  value: stats?.readyLinkedin ?? 0,
                  hint: "Connections & DMs",
                },
                {
                  label: "Email",
                  value: stats?.readyEmail ?? 0,
                  hint: stats?.emailAutoSend
                    ? "Manual queue only"
                    : "Auto-send is off",
                },
                {
                  label: "Done today",
                  value: stats?.sentToday ?? 0,
                  hint: `${stats?.skippedToday ?? 0} skipped`,
                },
              ] as const
            ).map((c) => (
              <div
                key={c.label}
                className="rounded-xl border border-border bg-card px-4 py-3"
              >
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {c.label}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {c.value}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {c.hint}
                </p>
              </div>
            ))}
          </div>

          {stats && !stats.emailAutoSend && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Email auto-send is{" "}
              <span className="font-medium text-foreground">off</span> — due
              emails land here for you to send. Change in{" "}
              <a
                href="/settings"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Settings → Outreach email
              </a>
              .
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Show</span>
            {(
              [
                ["all", "All"],
                ["linkedin", "LinkedIn"],
                ["email", "Email"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActivityFilter(id)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium",
                  activityFilter === id
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {id === "all" && stats
                  ? ` · ${stats.readyTotal}`
                  : id === "linkedin" && stats
                    ? ` · ${stats.readyLinkedin}`
                    : id === "email" && stats
                      ? ` · ${stats.readyEmail}`
                      : ""}
              </button>
            ))}
          </div>

          {loading && tasks.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Loading today&apos;s work…
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
              <Check className="size-8 text-emerald-500/80" />
              <p className="mt-4 text-sm font-medium">Nothing due right now</p>
              <p className="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">
                Enroll a list into a sequence, or wait for delayed steps to come
                due. Auto emails send in the background when enabled.
              </p>
              <div className="mt-5 flex gap-2">
                <Button variant="outline" onClick={() => setView("list")}>
                  Sequences
                </Button>
                <Button
                  onClick={() => {
                    setEnrollSeqId(sequences[0]?.id ?? "");
                    setEnrollOpen(true);
                  }}
                >
                  Enroll list
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Work top → bottom. Open · copy · send · mark done.
              </p>
              {filteredTasks.map((t, idx) => {
                const e = t.enrollment;
                const profile =
                  (t.meta?.profile_url as string) ||
                  e?.contactLinkedin ||
                  null;
                const isLi = t.channel === "linkedin";
                return (
                  <div
                    key={t.id}
                    className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/20 px-4 py-2.5">
                      <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold tabular-nums text-background">
                        {idx + 1}
                      </span>
                      <div
                        className={cn(
                          "flex size-7 items-center justify-center rounded-md",
                          isLi
                            ? "bg-[#0A66C2]/15 text-[#0A66C2]"
                            : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                        )}
                      >
                        {isLi ? (
                          <Linkedin className="size-3.5" />
                        ) : (
                          <Mail className="size-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">
                          {activityLabel(t)}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {e?.contactName ?? "—"}
                          {e?.contactRole ? ` · ${e.contactRole}` : ""}
                          {e?.companyName ? ` @ ${e.companyName}` : ""}
                          {t.sequenceName ? ` · ${t.sequenceName}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {isLi && profile && (
                          <Button size="sm" variant="outline" asChild>
                            <a
                              href={profile}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink className="size-3.5" />
                              Open LI
                            </a>
                          </Button>
                        )}
                        {!isLi && e?.contactEmail && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openEmailCompose(t)}
                          >
                            <Mail className="size-3.5" />
                            Open Gmail
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void copyText(
                              isLi
                                ? (t.renderedBody ?? "")
                                : [
                                    t.renderedSubject
                                      ? `Subject: ${t.renderedSubject}`
                                      : "",
                                    t.renderedBody ?? "",
                                  ]
                                    .filter(Boolean)
                                    .join("\n\n"),
                            );
                          }}
                        >
                          <Copy className="size-3.5" />
                          Copy
                        </Button>
                        <Button
                          size="sm"
                          disabled={busyId === t.id}
                          onClick={() => void complete(t.id, "sent")}
                        >
                          {busyId === t.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          Done
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === t.id}
                          onClick={() => void complete(t.id, "skipped")}
                        >
                          <SkipForward className="size-3.5" />
                          Skip
                        </Button>
                      </div>
                    </div>
                    <div className="px-4 py-3">
                      {!isLi && t.renderedSubject && (
                        <p className="mb-2 text-sm font-medium">
                          {t.renderedSubject}
                        </p>
                      )}
                      <pre className="whitespace-pre-wrap text-sm leading-relaxed text-pretty text-foreground/90">
                        {t.renderedBody}
                      </pre>
                      <p className="mt-3 text-[11px] text-muted-foreground">
                        {isLi
                          ? "1) Open LI  2) Paste  3) Send invite/DM  4) Done"
                          : "1) Open Gmail  2) Check & send  3) Done"}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New sequence</DialogTitle>
            <DialogDescription>
              Starts with a 3-step default cadence. You&apos;ll edit every step
              next.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. QA founders outbound"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void createSeq();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={creating || !newName.trim()}
              onClick={() => void createSeq()}
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        sequences={sequences}
        tables={tables}
        enrollSeqId={enrollSeqId}
        setEnrollSeqId={setEnrollSeqId}
        enrollTableId={enrollTableId}
        setEnrollTableId={setEnrollTableId}
        enrolling={enrolling}
        onEnroll={() => void enroll()}
      />
    </div>
  );
}

function EnrollDialog({
  open,
  onOpenChange,
  sequences,
  tables,
  enrollSeqId,
  setEnrollSeqId,
  enrollTableId,
  setEnrollTableId,
  enrolling,
  onEnroll,
  hideSequencePick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sequences: Sequence[];
  tables: ResearchTable[];
  enrollSeqId: string;
  setEnrollSeqId: (v: string) => void;
  enrollTableId: string;
  setEnrollTableId: (v: string) => void;
  enrolling: boolean;
  onEnroll: () => void;
  hideSequencePick?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enroll list</DialogTitle>
          <DialogDescription>
            People enter the sequence. LinkedIn steps land in the queue; email
            auto-sends when due.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!hideSequencePick && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Sequence
              </label>
              <Select value={enrollSeqId} onValueChange={setEnrollSeqId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose sequence" />
                </SelectTrigger>
                <SelectContent>
                  {sequences.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Research list
            </label>
            <Select value={enrollTableId} onValueChange={setEnrollTableId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose list" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.id} value={t.slug || t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              enrolling ||
              !enrollTableId ||
              (!hideSequencePick && !enrollSeqId)
            }
            onClick={onEnroll}
          >
            {enrolling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Enroll"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
