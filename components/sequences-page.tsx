"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
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
import { renderTemplate } from "@/lib/outreach/renderer";
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
  /** email only: new conversation vs reply in previous thread */
  emailThreadMode: "new" | "reply";
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

type EnrollmentRow = {
  id: string;
  companyName: string;
  domain: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLinkedin: string | null;
  contactRole: string | null;
  status: string;
  currentStepPosition: number;
  nextRunAt: string | null;
  lastError: string | null;
  source: string;
  createdAt: string;
};

type SequenceStepProgress = {
  position: number;
  channel: string;
  mode: string;
  status: string;
  error: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
};

type SequenceLeadProgress = {
  enrollment: EnrollmentRow;
  steps: SequenceStepProgress[];
  completedSteps: number;
  totalSteps: number;
  progressPct: number;
  lastTaskError: string | null;
};

type SequenceHealth = {
  sequenceId: string;
  totalSteps: number;
  enrollments: { total: number; byStatus: Record<string, number> };
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    email: Record<string, number>;
    linkedin: Record<string, number>;
  };
  rates: {
    bounceRate: number;
    emailFailRate: number;
    skipRate: number;
    completionRate: number;
  };
  recentErrors: Array<{
    contactName: string | null;
    companyName: string;
    channel: string;
    error: string;
    at: string;
    enrollmentStatus: string;
  }>;
  leads: SequenceLeadProgress[];
  steps: Array<{ position: number; channel: string; mode: string }>;
};

function stepStatusDot(status: string): string {
  switch (status) {
    case "sent":
      return "bg-emerald-500";
    case "failed":
      return "bg-rose-500";
    case "skipped":
      return "bg-amber-500";
    case "ready":
    case "sending":
      return "bg-sky-500";
    case "scheduled":
    case "pending":
      return "bg-muted-foreground/40";
    case "cancelled":
      return "bg-muted-foreground/30";
    default:
      return "bg-border";
  }
}

function enrollmentStatusBadge(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case "completed":
      return "bg-muted text-muted-foreground";
    case "bounced":
    case "failed":
      return "bg-rose-500/15 text-rose-700 dark:text-rose-400";
    case "paused":
    case "cancelled":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "replied":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

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
      emailThreadMode: "new",
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
    emailThreadMode: "new",
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
  const threadRaw = String(
    s.emailThreadMode ?? s.email_thread_mode ?? "reply",
  );
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
    emailThreadMode: channel === "email" && threadRaw === "new" ? "new" : "reply",
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
  const mode = s.mode === "auto" ? "Auto email" : "Manual email";
  return s.emailThreadMode === "reply" ? `${mode} · reply` : `${mode} · new`;
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
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
  const [sequenceHealth, setSequenceHealth] = useState<SequenceHealth | null>(
    null,
  );
  const [editorTab, setEditorTab] = useState<"dashboard" | "steps" | "people">(
    "dashboard",
  );
  const [peopleFilter, setPeopleFilter] = useState<
    "all" | "active" | "completed" | "bounced" | "other"
  >("all");
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(null);
  const [previewPersonId, setPreviewPersonId] = useState<string | "sample">(
    "sample",
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      setSequenceHealth((data.health as SequenceHealth) ?? null);
      const enrRaw = (data.enrollments ?? []) as Record<string, unknown>[];
      const enrMapped: EnrollmentRow[] = enrRaw.map((e) => ({
        id: String(e.id),
        companyName: String(e.companyName ?? e.company_name ?? ""),
        domain: (e.domain as string | null) ?? null,
        contactName: (e.contactName ?? e.contact_name ?? null) as string | null,
        contactEmail: (e.contactEmail ?? e.contact_email ?? null) as
          | string
          | null,
        contactLinkedin: (e.contactLinkedin ??
          e.contact_linkedin ??
          null) as string | null,
        contactRole: (e.contactRole ?? e.contact_role ?? null) as string | null,
        status: String(e.status ?? "active"),
        currentStepPosition: Number(
          e.currentStepPosition ?? e.current_step_position ?? 0,
        ),
        nextRunAt: (e.nextRunAt ?? e.next_run_at ?? null) as string | null,
        lastError: (e.lastError ?? e.last_error ?? null) as string | null,
        source: String(e.source ?? "research"),
        createdAt: String(e.createdAt ?? e.created_at ?? ""),
      }));
      setEnrollments(enrMapped);
      setEnrollmentCount(enrMapped.length);
      // Prefer health dashboard when anyone is enrolled
      setEditorTab(enrMapped.length > 0 ? "dashboard" : "steps");
      // Prefer a real person for sequence preview
      const firstActive =
        enrMapped.find((e) => e.status === "active") ?? enrMapped[0];
      setPreviewPersonId(firstActive?.id ?? "sample");
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

  const reloadEnrollments = async (sequenceId: string) => {
    if (!token) return;
    const res = await fetch(`/api/outreach/sequences/${sequenceId}`, {
      headers: headers(),
    });
    if (!res.ok) return;
    const data = await res.json();
    const enrRaw = (data.enrollments ?? []) as Record<string, unknown>[];
    const enrMapped: EnrollmentRow[] = enrRaw.map((e) => ({
      id: String(e.id),
      companyName: String(e.companyName ?? e.company_name ?? ""),
      domain: (e.domain as string | null) ?? null,
      contactName: (e.contactName ?? e.contact_name ?? null) as string | null,
      contactEmail: (e.contactEmail ?? e.contact_email ?? null) as
        | string
        | null,
      contactLinkedin: (e.contactLinkedin ?? e.contact_linkedin ?? null) as
        | string
        | null,
      contactRole: (e.contactRole ?? e.contact_role ?? null) as string | null,
      status: String(e.status ?? "active"),
      currentStepPosition: Number(
        e.currentStepPosition ?? e.current_step_position ?? 0,
      ),
      nextRunAt: (e.nextRunAt ?? e.next_run_at ?? null) as string | null,
      lastError: (e.lastError ?? e.last_error ?? null) as string | null,
      source: String(e.source ?? "research"),
      createdAt: String(e.createdAt ?? e.created_at ?? ""),
    }));
    setEnrollments(enrMapped);
    setEnrollmentCount(enrMapped.length);
    setSequenceHealth((data.health as SequenceHealth) ?? null);
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
            emailThreadMode:
              s.channel === "email" ? s.emailThreadMode : null,
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

  const deleteSequence = async () => {
    if (!token || !editingId) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}`, {
        method: "DELETE",
        headers: headers(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (data as { error?: string }).error ?? "Failed to delete sequence",
        );
        setDeleteOpen(false);
        return;
      }
      setDeleteOpen(false);
      setEditingId(null);
      setView("list");
      setNotice(
        `Deleted “${(data as { name?: string }).name ?? "sequence"}”` +
          ((data as { deletedEnrollments?: number }).deletedEnrollments
            ? ` · ${(data as { deletedEnrollments: number }).deletedEnrollments} people removed`
            : ""),
      );
      await load();
    } finally {
      setDeleting(false);
    }
  };

  /** Status is intentional — applies immediately (does not wait for Save). */
  const changeStatus = async (status: string) => {
    if (!token || !editingId) return;
    const prev = editStatus;
    setEditStatus(status);
    setError(null);
    setNotice(null);
    setBusyId("status");
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditStatus(prev);
        setError((data as { error?: string }).error ?? "Failed to update status");
        return;
      }
      const labels: Record<string, string> = {
        draft: "Draft — not running. Activate when ready.",
        active: "Active — queue and auto-email will run.",
        paused: "Paused — tasks held until you activate again.",
        archived: "Archived — hidden from normal use.",
      };
      setNotice(labels[status] ?? `Status → ${status}`);
      await load();
    } finally {
      setBusyId(null);
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
          if (!next.emailThreadMode) next.emailThreadMode = "new";
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
      const seqStatus = String(data.sequenceStatus ?? editStatus ?? "draft");
      const parts = [
        `Enrolled ${data.enrolled}`,
        data.skipped ? `skipped ${data.skipped}` : null,
        data.missingLinkedin
          ? `${data.missingLinkedin} without LinkedIn`
          : null,
        data.missingEmail
          ? `${data.missingEmail} without email (email steps will be skipped)`
          : null,
        seqStatus !== "active"
          ? `sequence is ${seqStatus} — Activate to start outreach`
          : null,
      ].filter(Boolean);
      setNotice(
        `${parts.join(" · ")}. Check People for warnings.`,
      );
      if (
        (data.errors as string[] | undefined)?.length ||
        (data.warnings as string[] | undefined)?.length
      ) {
        const bits = [
          ...((data.errors as string[]) ?? []).slice(0, 5),
          ...((data.warnings as string[]) ?? []).slice(0, 5),
        ];
        setError(bits.join(" · "));
      }
      await load();
      // Stay on sequence editor → People so you see who is running
      if (enrollSeqId) {
        setEditingId(enrollSeqId);
        setView("editor");
        await openEditor(enrollSeqId);
        setEditorTab("people");
      }
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

    const filteredPeople = enrollments.filter((e) => {
      if (peopleFilter === "all") return true;
      if (peopleFilter === "active") return e.status === "active";
      if (peopleFilter === "completed") return e.status === "completed";
      if (peopleFilter === "bounced")
        return e.status === "bounced" || e.status === "failed";
      return (
        e.status !== "active" &&
        e.status !== "completed" &&
        e.status !== "bounced" &&
        e.status !== "failed"
      );
    });

    const activePeople = enrollments.filter((e) => e.status === "active").length;
    const leadById = new Map(
      (sequenceHealth?.leads ?? []).map((l) => [l.enrollment.id, l]),
    );
    const stepLabel = (pos: number) => {
      const s = editSteps[pos];
      if (!s) return `Step ${pos + 1}`;
      return `Step ${pos + 1} · ${stepTitle(s)}`;
    };

    const healthCards = sequenceHealth
      ? [
          {
            label: "Enrolled",
            value: sequenceHealth.enrollments.total,
            hint: `${sequenceHealth.enrollments.byStatus.active ?? 0} active`,
            warn: false,
          },
          {
            label: "Completed",
            value: sequenceHealth.enrollments.byStatus.completed ?? 0,
            hint: `${sequenceHealth.rates.completionRate}% of leads`,
            warn: false,
          },
          {
            label: "Bounced",
            value: sequenceHealth.enrollments.byStatus.bounced ?? 0,
            hint: `${sequenceHealth.rates.bounceRate}% bounce rate`,
            warn: (sequenceHealth.enrollments.byStatus.bounced ?? 0) > 0,
          },
          {
            label: "Email failed",
            value: sequenceHealth.tasks.email.failed ?? 0,
            hint: `${sequenceHealth.rates.emailFailRate}% of email decisions`,
            warn: (sequenceHealth.tasks.email.failed ?? 0) > 0,
          },
          {
            label: "Emails sent",
            value: sequenceHealth.tasks.email.sent ?? 0,
            hint: `${sequenceHealth.tasks.email.skipped ?? 0} skipped`,
            warn: false,
          },
          {
            label: "Skipped tasks",
            value: sequenceHealth.tasks.byStatus.skipped ?? 0,
            hint: `${sequenceHealth.rates.skipRate}% of finished tasks`,
            warn: false,
          },
        ]
      : [];

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
              Outbound
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
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={editStatus}
                onValueChange={(v) => void changeStatus(v)}
                disabled={busyId === "status"}
              >
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
              {editStatus !== "active" && editStatus !== "archived" && (
                <Button
                  size="sm"
                  disabled={busyId === "status"}
                  onClick={() => void changeStatus("active")}
                >
                  {busyId === "status" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Activate
                </Button>
              )}
              {editStatus === "active" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === "status"}
                  onClick={() => void changeStatus("paused")}
                >
                  Pause
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEnrollSeqId(editingId);
                  setEnrollOpen(true);
                }}
              >
                <Users className="size-3.5" />
                Enroll list
              </Button>
              {editorTab === "steps" && (
                <Button size="sm" disabled={saving} onClick={() => void saveSequence()}>
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  Save
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                title="Delete sequence"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>

          {editStatus !== "active" && (
            <div className="mx-auto mt-3 max-w-6xl rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-pretty text-muted-foreground">
              {editStatus === "draft" && (
                <>
                  <span className="font-medium text-foreground">Draft</span> —
                  you can enroll people and edit steps, but nothing runs until
                  you hit <span className="font-medium text-foreground">Activate</span>.
                </>
              )}
              {editStatus === "paused" && (
                <>
                  <span className="font-medium text-foreground">Paused</span> —
                  people stay enrolled; queue work and auto-email are held.
                  Activate to resume.
                </>
              )}
              {editStatus === "archived" && (
                <>
                  <span className="font-medium text-foreground">Archived</span> —
                  this sequence is inactive. Set Active to run it again, or
                  delete it.
                </>
              )}
            </div>
          )}

          {/* Dashboard | Steps | People tabs */}
          <div className="mx-auto mt-3 flex max-w-6xl gap-1 border-b border-border">
            {(
              [
                ["dashboard", "Dashboard", enrollmentCount],
                ["steps", "Steps", editSteps.length],
                ["people", "People", enrollmentCount],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                onClick={() =>
                  setEditorTab(id as "dashboard" | "steps" | "people")
                }
                className={cn(
                  "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm",
                  editorTab === id
                    ? "border-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                  {count}
                </span>
              </button>
            ))}
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
        ) : editorTab === "dashboard" ? (
          /* ── Dashboard: health + per-lead progress ── */
          <div className="mx-auto min-h-0 w-full max-w-6xl flex-1 space-y-6 overflow-y-auto px-4 py-6 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Sequence health</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Bounce, failures, skips, and where each lead is in the cadence.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void reloadEnrollments(editingId)}
              >
                <RefreshCw className="size-3.5" />
                Refresh
              </Button>
            </div>

            {!sequenceHealth || sequenceHealth.enrollments.total === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center">
                <Users className="size-8 text-muted-foreground/60" />
                <p className="mt-4 text-sm font-medium">No enrollments yet</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Enroll people from a research list to see health metrics and
                  progress.
                </p>
                <Button
                  className="mt-5"
                  onClick={() => {
                    setEnrollSeqId(editingId);
                    setEnrollOpen(true);
                  }}
                >
                  <Users className="size-3.5" />
                  Enroll from list
                </Button>
              </div>
            ) : (
              <>
                {(sequenceHealth.rates.bounceRate > 5 ||
                  sequenceHealth.rates.emailFailRate > 10 ||
                  (sequenceHealth.enrollments.byStatus.failed ?? 0) > 0) && (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-800 dark:text-rose-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <p className="font-medium">Delivery looks unhealthy</p>
                      <p className="mt-0.5 text-xs opacity-90">
                        Bounce {sequenceHealth.rates.bounceRate}% · email fail{" "}
                        {sequenceHealth.rates.emailFailRate}% · check recent
                        errors below and list quality (valid emails).
                      </p>
                    </div>
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {healthCards.map((c) => (
                    <div
                      key={c.label}
                      className={cn(
                        "rounded-xl border bg-card px-4 py-3",
                        c.warn
                          ? "border-rose-500/40 bg-rose-500/5"
                          : "border-border",
                      )}
                    >
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {c.label}
                      </p>
                      <p
                        className={cn(
                          "mt-1 text-2xl font-semibold tabular-nums",
                          c.warn && "text-rose-700 dark:text-rose-400",
                        )}
                      >
                        {c.value}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {c.hint}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Task breakdown */}
                <div className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Task outcomes
                  </h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ["Email", sequenceHealth.tasks.email],
                        ["LinkedIn", sequenceHealth.tasks.linkedin],
                      ] as const
                    ).map(([label, map]) => (
                      <div key={label}>
                        <p className="text-sm font-medium">{label}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(
                            [
                              ["sent", "Sent"],
                              ["failed", "Failed"],
                              ["skipped", "Skipped"],
                              ["scheduled", "Scheduled"],
                              ["ready", "Ready"],
                            ] as const
                          ).map(([k, lab]) => (
                            <span
                              key={k}
                              className={cn(
                                "rounded-md px-2 py-0.5 text-[11px] tabular-nums",
                                k === "failed" && (map[k] ?? 0) > 0
                                  ? "bg-rose-500/15 text-rose-700 dark:text-rose-400"
                                  : k === "skipped" && (map[k] ?? 0) > 0
                                    ? "bg-amber-500/15 text-amber-800 dark:text-amber-400"
                                    : "bg-muted text-muted-foreground",
                              )}
                            >
                              {lab} {map[k] ?? 0}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Recent errors */}
                {sequenceHealth.recentErrors.length > 0 && (
                  <div className="rounded-xl border border-border bg-card p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Recent errors
                    </h3>
                    <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
                      {sequenceHealth.recentErrors.map((err, i) => (
                        <li
                          key={`${err.at}-${i}`}
                          className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {err.contactName || "—"}
                            </span>
                            <span className="text-muted-foreground">
                              {err.companyName}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {err.channel}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                enrollmentStatusBadge(err.enrollmentStatus),
                              )}
                            >
                              {err.enrollmentStatus}
                            </Badge>
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-rose-700 dark:text-rose-400">
                            {err.error}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Per-lead progress */}
                <div className="rounded-xl border border-border">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h3 className="text-sm font-semibold">Lead progress</h3>
                    <p className="text-[11px] text-muted-foreground">
                      {sequenceHealth.totalSteps} steps · dots = status
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Person</th>
                          <th className="px-2 py-2 font-medium">Status</th>
                          <th className="px-2 py-2 font-medium">Progress</th>
                          <th className="px-2 py-2 font-medium">Steps</th>
                          <th className="px-4 py-2 font-medium">Issue</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {sequenceHealth.leads.map((lead) => {
                          const e = lead.enrollment;
                          return (
                            <tr key={e.id} className="hover:bg-muted/20">
                              <td className="px-4 py-2.5">
                                <p className="truncate font-medium">
                                  {e.contactName || "—"}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {e.companyName}
                                  {e.contactEmail
                                    ? ` · ${e.contactEmail}`
                                    : " · no email"}
                                </p>
                              </td>
                              <td className="px-2 py-2.5">
                                <span
                                  className={cn(
                                    "inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium capitalize",
                                    enrollmentStatusBadge(e.status),
                                  )}
                                >
                                  {e.status}
                                </span>
                              </td>
                              <td className="px-2 py-2.5">
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={cn(
                                        "h-full rounded-full",
                                        e.status === "bounced" ||
                                          e.status === "failed"
                                          ? "bg-rose-500"
                                          : e.status === "completed"
                                            ? "bg-emerald-500"
                                            : "bg-foreground/70",
                                      )}
                                      style={{ width: `${lead.progressPct}%` }}
                                    />
                                  </div>
                                  <span className="text-[11px] tabular-nums text-muted-foreground">
                                    {lead.completedSteps}/{lead.totalSteps}
                                  </span>
                                </div>
                              </td>
                              <td className="px-2 py-2.5">
                                <div className="flex items-center gap-1">
                                  {lead.steps.map((s) => (
                                    <span
                                      key={s.position}
                                      title={`Step ${s.position + 1} ${s.channel}: ${s.status}${s.error ? ` — ${s.error}` : ""}`}
                                      className={cn(
                                        "size-2.5 rounded-full",
                                        stepStatusDot(s.status),
                                        s.channel === "email" &&
                                          "ring-1 ring-offset-1 ring-offset-background ring-foreground/10",
                                      )}
                                    />
                                  ))}
                                </div>
                              </td>
                              <td className="max-w-[180px] px-4 py-2.5">
                                {lead.lastTaskError ? (
                                  <p
                                    className="truncate font-mono text-[10px] text-rose-600 dark:text-rose-400"
                                    title={lead.lastTaskError}
                                  >
                                    {lead.lastTaskError}
                                  </p>
                                ) : !e.contactEmail ? (
                                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                                    No email
                                  </p>
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap gap-3 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-emerald-500" /> sent
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-rose-500" /> failed
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-amber-500" /> skipped
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-sky-500" /> ready
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-muted-foreground/40" />{" "}
                      scheduled / pending
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : editorTab === "people" ? (
          /* ── People: who is running this sequence ── */
          <div className="mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">People in this sequence</h2>
                <p className="mt-0.5 text-xs text-pretty text-muted-foreground">
                  {activePeople} active · {enrollmentCount} total.
                  {enrollments.filter((e) => !e.contactLinkedin).length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {" "}
                      · {enrollments.filter((e) => !e.contactLinkedin).length}{" "}
                      missing LinkedIn
                    </span>
                  )}
                  {enrollments.filter((e) => !e.contactEmail).length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {" "}
                      · {enrollments.filter((e) => !e.contactEmail).length}{" "}
                      missing email (email steps skipped)
                    </span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void reloadEnrollments(editingId)}
                >
                  <RefreshCw className="size-3.5" />
                  Refresh
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEnrollSeqId(editingId);
                    setEnrollOpen(true);
                  }}
                >
                  <Plus className="size-3.5" />
                  Enroll from list
                </Button>
              </div>
            </div>

            <div className="mb-4 flex flex-wrap gap-1.5">
              {(
                [
                  ["all", "All"],
                  ["active", "Active"],
                  ["completed", "Completed"],
                  ["bounced", "Bounced / failed"],
                  ["other", "Paused / other"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPeopleFilter(id)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium",
                    peopleFilter === id
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {filteredPeople.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
                <Users className="size-8 text-muted-foreground/60" />
                <p className="mt-4 text-sm font-medium">
                  {enrollmentCount === 0
                    ? "Nobody enrolled yet"
                    : "No people in this filter"}
                </p>
                <p className="mt-1 max-w-md text-sm text-pretty text-muted-foreground">
                  {enrollmentCount === 0
                    ? "Click Enroll from list and pick a research list. Every person on those companies is added here and starts the cadence."
                    : "Try another filter."}
                </p>
                {enrollmentCount === 0 && (
                  <Button
                    className="mt-5"
                    onClick={() => {
                      setEnrollSeqId(editingId);
                      setEnrollOpen(true);
                    }}
                  >
                    <Users className="size-3.5" />
                    Enroll from list
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border">
                <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_88px_minmax(0,0.9fr)_minmax(0,1fr)_80px_64px] gap-2 border-b border-border bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span>Person</span>
                  <span>Company</span>
                  <span>Status</span>
                  <span>Progress</span>
                  <span>Current step</span>
                  <span>Next</span>
                  <span />
                </div>
                <ul className="divide-y divide-border">
                  {filteredPeople.map((e) => (
                    <li
                      key={e.id}
                      className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_88px_minmax(0,0.9fr)_minmax(0,1fr)_80px_64px] items-center gap-2 px-4 py-3 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="truncate font-medium">
                            {e.contactName || "—"}
                          </p>
                          {!e.contactLinkedin && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                              No LinkedIn
                            </span>
                          )}
                          {!e.contactEmail && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                              No email
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          {e.contactRole && (
                            <span className="truncate">{e.contactRole}</span>
                          )}
                          {e.contactEmail ? (
                            <span className="truncate font-mono">
                              {e.contactEmail}
                            </span>
                          ) : (
                            <span className="text-amber-600/90 dark:text-amber-400/90">
                              email missing
                            </span>
                          )}
                          {e.contactLinkedin ? (
                            <a
                              href={e.contactLinkedin}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 text-[#0A66C2] hover:underline"
                              onClick={(ev) => ev.stopPropagation()}
                            >
                              <Linkedin className="size-3" />
                              LI
                            </a>
                          ) : (
                            <span className="text-amber-600/90 dark:text-amber-400/90">
                              LI missing
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate">{e.companyName}</p>
                        {e.domain && (
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {e.domain}
                          </p>
                        )}
                      </div>
                      <div>
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2 py-0.5 text-[11px] capitalize",
                            enrollmentStatusBadge(e.status),
                          )}
                        >
                          {e.status}
                        </span>
                      </div>
                      <div className="min-w-0">
                        {(() => {
                          const lead = leadById.get(e.id);
                          if (!lead) {
                            return (
                              <span className="text-[11px] text-muted-foreground">
                                —
                              </span>
                            );
                          }
                          return (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1">
                                {lead.steps.map((s) => (
                                  <span
                                    key={s.position}
                                    title={`Step ${s.position + 1} ${s.channel}: ${s.status}`}
                                    className={cn(
                                      "size-2 rounded-full",
                                      stepStatusDot(s.status),
                                    )}
                                  />
                                ))}
                              </div>
                              <span className="text-[10px] tabular-nums text-muted-foreground">
                                {lead.completedSteps}/{lead.totalSteps} ·{" "}
                                {lead.progressPct}%
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="min-w-0 text-xs text-muted-foreground">
                        <p className="truncate text-foreground">
                          {e.status === "completed"
                            ? "Finished"
                            : stepLabel(e.currentStepPosition)}
                        </p>
                        {e.lastError && (
                          <p className="truncate text-destructive">
                            {e.lastError}
                          </p>
                        )}
                      </div>
                      <div className="text-xs tabular-nums text-muted-foreground">
                        {e.status === "active" && e.nextRunAt
                          ? new Date(e.nextRunAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })
                          : "—"}
                      </div>
                      <div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => {
                            setPreviewPersonId(e.id);
                            setEditorTab("steps");
                          }}
                        >
                          Preview
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          /* Instantly-style vertical sequence builder */
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6">
              {/* Meta */}
              <div className="mb-6 space-y-3">
                <Input
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Description (optional)"
                  className="h-9 border-border/60 bg-transparent text-sm"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {editSteps.length} step{editSteps.length === 1 ? "" : "s"}
                    {activePeople > 0
                      ? ` · ${activePeople} people active`
                      : " · enroll people when ready"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => {
                        const s = blankStep("linkedin");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                    >
                      <Linkedin className="size-3.5 text-[#0A66C2]" />
                      LinkedIn step
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => {
                        const s = blankStep("email");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                    >
                      <Mail className="size-3.5 text-amber-600" />
                      Email step
                    </Button>
                  </div>
                </div>
              </div>

              {/* Vertical timeline */}
              <div className="relative space-y-0">
                {editSteps.map((step, idx) => {
                  const isSel = selected?.key === step.key;
                  const waitDays = Math.floor(step.delayHours / 24);
                  const waitHours = step.delayHours % 24;
                  const previewPerson =
                    previewPersonId === "sample"
                      ? {
                          companyName: "Acme QA",
                          domain: "acme.com",
                          contactName: "Alex Chen",
                          contactEmail: "alex@acme.com",
                          contactLinkedin: "https://linkedin.com/in/alex",
                          contactRole: "Head of QA",
                        }
                      : (() => {
                          const e = enrollments.find(
                            (x) => x.id === previewPersonId,
                          );
                          return e
                            ? {
                                companyName: e.companyName,
                                domain: e.domain,
                                contactName: e.contactName,
                                contactEmail: e.contactEmail,
                                contactLinkedin: e.contactLinkedin,
                                contactRole: e.contactRole,
                              }
                            : {
                                companyName: "Acme QA",
                                domain: "acme.com",
                                contactName: "Alex Chen",
                                contactEmail: "alex@acme.com",
                                contactLinkedin:
                                  "https://linkedin.com/in/alex",
                                contactRole: "Head of QA",
                              };
                        })();
                  const renderedBody = renderTemplate(
                    step.bodyTemplate,
                    previewPerson,
                  );
                  const renderedSubject =
                    step.channel === "email" && step.subjectTemplate
                      ? renderTemplate(step.subjectTemplate, previewPerson)
                      : null;

                  return (
                    <div key={step.key} className="relative">
                      {/* Wait connector between steps */}
                      {idx > 0 && (
                        <div className="flex items-center gap-3 py-2 pl-4">
                          <div className="flex w-8 flex-col items-center">
                            <div className="h-4 w-px bg-border" />
                          </div>
                          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
                            <Clock className="size-3" />
                            Wait {formatWait(step.delayHours).toLowerCase()}
                          </div>
                        </div>
                      )}

                      <div className="flex gap-3">
                        {/* Timeline rail */}
                        <div className="flex w-8 shrink-0 flex-col items-center pt-3">
                          <div
                            className={cn(
                              "z-[1] flex size-8 items-center justify-center rounded-full border-2 text-xs font-semibold tabular-nums",
                              isSel
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-background text-muted-foreground",
                            )}
                          >
                            {idx + 1}
                          </div>
                          {idx < editSteps.length - 1 && !isSel && (
                            <div className="w-px flex-1 bg-border" />
                          )}
                          {idx < editSteps.length - 1 && isSel && (
                            <div className="w-px flex-1 bg-border" />
                          )}
                        </div>

                        {/* Step card */}
                        <div
                          className={cn(
                            "mb-1 min-w-0 flex-1 overflow-hidden rounded-xl border transition",
                            isSel
                              ? "border-foreground/20 bg-card shadow-sm"
                              : "border-border bg-card/60 hover:border-foreground/15 hover:bg-card",
                          )}
                        >
                          {/* Collapsed header — always visible */}
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedStepKey(isSel ? step.key : step.key)
                            }
                            className="flex w-full items-start gap-3 p-4 text-left"
                          >
                            <span
                              className={cn(
                                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                                step.channel === "linkedin"
                                  ? "bg-[#0A66C2]/12 text-[#0A66C2]"
                                  : "bg-amber-500/12 text-amber-600 dark:text-amber-400",
                              )}
                            >
                              {step.channel === "linkedin" ? (
                                <Linkedin className="size-4" />
                              ) : (
                                <Mail className="size-4" />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold">
                                  {stepTitle(step)}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {idx === 0
                                    ? "Day 0 · on enroll"
                                    : formatWait(step.delayHours)}
                                  {step.channel === "linkedin"
                                    ? " · manual"
                                    : step.mode === "auto"
                                      ? " · auto"
                                      : " · manual"}
                                </span>
                              </div>
                              {!isSel && (
                                <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                                  {step.channel === "email" &&
                                  step.subjectTemplate
                                    ? `${step.subjectTemplate} — `
                                    : ""}
                                  {step.bodyTemplate || "Empty message…"}
                                </p>
                              )}
                            </div>
                          </button>

                          {/* Expanded editor */}
                          {isSel && (
                            <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
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
                                        [n[idx - 1], n[idx]] = [
                                          n[idx],
                                          n[idx - 1],
                                        ];
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
                                        if (idx >= prev.length - 1)
                                          return prev;
                                        const n = [...prev];
                                        [n[idx], n[idx + 1]] = [
                                          n[idx + 1],
                                          n[idx],
                                        ];
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
                                    aria-label="Delete step"
                                    onClick={() => {
                                      setEditSteps((p) => {
                                        const next = p.filter(
                                          (x) => x.key !== step.key,
                                        );
                                        setSelectedStepKey(
                                          next[Math.max(0, idx - 1)]?.key ??
                                            next[0]?.key ??
                                            null,
                                        );
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
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Action
                                  </p>
                                  <Segmented
                                    value={
                                      step.linkedinAction ?? "connect_note"
                                    }
                                    onChange={(v) =>
                                      updateStep(step.key, {
                                        linkedinAction: v,
                                      })
                                    }
                                    options={[
                                      {
                                        value: "connect_note" as const,
                                        label: "Connection + note",
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
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Send mode
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
                                        label: "Manual",
                                      },
                                    ]}
                                  />
                                </div>
                              )}

                              {step.channel === "email" && (
                                <div className="space-y-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Conversation
                                  </p>
                                  <Segmented
                                    value={step.emailThreadMode}
                                    onChange={(v) =>
                                      updateStep(step.key, {
                                        emailThreadMode: v,
                                      })
                                    }
                                    options={[
                                      {
                                        value: "new" as const,
                                        label: "New thread",
                                      },
                                      {
                                        value: "reply" as const,
                                        label: "Reply in thread",
                                      },
                                    ]}
                                  />
                                  <p className="text-[11px] text-muted-foreground">
                                    {step.emailThreadMode === "reply"
                                      ? "Sends as a reply to the previous email for this lead (same Gmail thread)."
                                      : "Starts a brand-new email conversation (no In-Reply-To)."}
                                  </p>
                                </div>
                              )}

                              <div className="space-y-1.5">
                                <p className="text-[11px] font-medium text-muted-foreground">
                                  Delay after previous step
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1">
                                    <Input
                                      type="number"
                                      min={0}
                                      className="h-7 w-12 border-0 p-0 text-sm shadow-none focus-visible:ring-0"
                                      value={waitDays}
                                      onChange={(e) =>
                                        updateStep(step.key, {
                                          delayHours:
                                            Math.max(
                                              0,
                                              Number(e.target.value) || 0,
                                            ) *
                                              24 +
                                            waitHours,
                                        })
                                      }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                      d
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1">
                                    <Input
                                      type="number"
                                      min={0}
                                      max={23}
                                      className="h-7 w-12 border-0 p-0 text-sm shadow-none focus-visible:ring-0"
                                      value={waitHours}
                                      onChange={(e) =>
                                        updateStep(step.key, {
                                          delayHours:
                                            waitDays * 24 +
                                            Math.max(
                                              0,
                                              Number(e.target.value) || 0,
                                            ),
                                        })
                                      }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                      h
                                    </span>
                                  </div>
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

                              {step.channel === "email" && (
                                <div className="space-y-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Subject
                                  </p>
                                  <Input
                                    value={step.subjectTemplate}
                                    onChange={(e) =>
                                      updateStep(step.key, {
                                        subjectTemplate: e.target.value,
                                      })
                                    }
                                    placeholder="Subject…"
                                  />
                                </div>
                              )}

                              <div className="space-y-1.5">
                                <div className="flex justify-between">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    {step.channel === "linkedin"
                                      ? step.linkedinAction === "connect_note"
                                        ? "Connection note"
                                        : "Message"
                                      : "Email body"}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {"{{first_name}} {{company}}"}
                                  </p>
                                </div>
                                <Textarea
                                  value={step.bodyTemplate}
                                  onChange={(e) =>
                                    updateStep(step.key, {
                                      bodyTemplate: e.target.value,
                                    })
                                  }
                                  rows={step.channel === "email" ? 7 : 4}
                                  className="resize-y text-sm leading-relaxed"
                                />
                              </div>

                              {/* Live preview strip */}
                              <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5">
                                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    Preview
                                  </p>
                                  <Select
                                    value={previewPersonId}
                                    onValueChange={(v) =>
                                      setPreviewPersonId(
                                        v as string | "sample",
                                      )
                                    }
                                  >
                                    <SelectTrigger className="h-7 w-auto min-w-[140px] border-0 bg-transparent text-[11px] shadow-none">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="sample">
                                        Sample · Alex
                                      </SelectItem>
                                      {enrollments.map((e) => (
                                        <SelectItem key={e.id} value={e.id}>
                                          {e.contactName || e.companyName}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                {renderedSubject && (
                                  <p className="mb-1 text-xs font-medium">
                                    {renderedSubject}
                                  </p>
                                )}
                                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                                  {renderedBody || "…"}
                                </pre>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Add step */}
                <div className="flex items-center gap-3 pt-4">
                  <div className="flex w-8 justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        const s = blankStep("linkedin");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                      className="flex size-8 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
                      aria-label="Add step"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const s = blankStep("linkedin");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      + LinkedIn step
                    </button>
                    <span className="text-muted-foreground/40">·</span>
                    <button
                      type="button"
                      onClick={() => {
                        const s = blankStep("email");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      + Email step
                    </button>
                  </div>
                </div>
              </div>
            </div>
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

        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete sequence?</DialogTitle>
              <DialogDescription>
                This permanently removes{" "}
                <span className="font-medium text-foreground">
                  {editName || "this sequence"}
                </span>
                , all steps, {enrollmentCount} enrolled{" "}
                {enrollmentCount === 1 ? "person" : "people"}, and their queue
                tasks. This cannot be undone. Prefer{" "}
                <span className="font-medium text-foreground">Archived</span>{" "}
                status if you only want to hide it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={deleting}
                onClick={() => setDeleteOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={deleting}
                onClick={() => void deleteSequence()}
              >
                {deleting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Delete forever
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
            Every person on companies in the research list is added to this
            sequence (you&apos;ll see them under People). First due steps go to
            Today / auto email.
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
