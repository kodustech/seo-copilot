"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
  meta: Record<string, unknown>;
  enrollment?: {
    companyName: string;
    domain: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactLinkedin: string | null;
    contactRole: string | null;
  };
  step?: {
    linkedinAction: string | null;
    position: number;
  };
};

type ResearchTable = { id: string; name: string; slug?: string | null };

const TOKEN_HINT =
  "Personalize with {{first_name}} {{full_name}} {{company}} {{domain}} {{role}} {{email}} {{linkedin}}";

function formatWait(hours: number): string {
  if (hours <= 0) return "immediately";
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  if (d > 0 && h > 0) return `after ${d}d ${h}h`;
  if (d > 0) return `after ${d} day${d === 1 ? "" : "s"}`;
  return `after ${h} hour${h === 1 ? "" : "s"}`;
}

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

function newStepKey() {
  return `s_${Math.random().toString(36).slice(2, 10)}`;
}

function blankStep(channel: "email" | "linkedin" = "linkedin"): StepDraft {
  if (channel === "email") {
    return {
      key: newStepKey(),
      channel: "email",
      mode: "auto",
      delayHours: 24,
      linkedinAction: null,
      subjectTemplate: "Quick note for {{company}}",
      bodyTemplate: `Hi {{first_name}},

Noticed {{company}} is investing in quality/engineering. Worth a quick chat?

— Kodus`,
    };
  }
  return {
    key: newStepKey(),
    channel: "linkedin",
    mode: "semi",
    delayHours: 0,
    linkedinAction: "connect_note",
    subjectTemplate: "",
    bodyTemplate:
      "Hey {{first_name}} — saw {{company}} is hiring for QA. Open to a quick chat?",
  };
}

function mapApiStep(s: {
  channel: string;
  mode: string;
  delayHours?: number;
  delay_hours?: number;
  linkedinAction?: string | null;
  linkedin_action?: string | null;
  subjectTemplate?: string | null;
  subject_template?: string | null;
  bodyTemplate?: string;
  body_template?: string;
}): StepDraft {
  const channel = s.channel === "email" ? "email" : "linkedin";
  const action = (s.linkedinAction ?? s.linkedin_action ?? "message") as
    | "connect_note"
    | "message";
  return {
    key: newStepKey(),
    channel,
    mode: channel === "linkedin" ? "semi" : s.mode === "semi" ? "semi" : "auto",
    delayHours: Number(s.delayHours ?? s.delay_hours ?? 0),
    linkedinAction: channel === "linkedin" ? action : null,
    subjectTemplate: String(s.subjectTemplate ?? s.subject_template ?? ""),
    bodyTemplate: String(s.bodyTemplate ?? s.body_template ?? ""),
  };
}

export function SequencesPage() {
  const token = useAuthToken();
  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const [tab, setTab] = useState<"queue" | "sequences">("sequences");
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [tables, setTables] = useState<ResearchTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mailboxConfigured, setMailboxConfigured] = useState(true);

  // Editor
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState("draft");
  const [editSteps, setEditSteps] = useState<StepDraft[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enrollmentCount, setEnrollmentCount] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("QA founders outreach");
  const [creating, setCreating] = useState(false);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollSeqId, setEnrollSeqId] = useState<string>("");
  const [enrollTableId, setEnrollTableId] = useState<string>("");
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [seqRes, queueRes, tablesRes] = await Promise.all([
        fetch("/api/outreach/sequences", { headers: headers() }),
        fetch("/api/outreach/sequences/queue?channel=linkedin", {
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
    setEditLoading(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${id}`, {
        headers: headers(),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Failed to load sequence");
        setEditingId(null);
        return;
      }
      setEditName(data.sequence?.name ?? "");
      setEditDescription(data.sequence?.description ?? "");
      setEditStatus(data.sequence?.status ?? "draft");
      setEnrollmentCount((data.enrollments as unknown[])?.length ?? 0);
      const steps = (data.steps ?? []).map(
        (s: Record<string, unknown>) =>
          mapApiStep({
            channel: String(s.channel),
            mode: String(s.mode),
            delayHours: Number(s.delayHours ?? s.delay_hours ?? 0),
            linkedinAction: (s.linkedinAction ?? s.linkedin_action) as
              | string
              | null,
            subjectTemplate: (s.subjectTemplate ?? s.subject_template) as
              | string
              | null,
            bodyTemplate: String(s.bodyTemplate ?? s.body_template ?? ""),
          }),
      );
      setEditSteps(steps.length ? steps : [blankStep("linkedin")]);
      setTab("sequences");
    } finally {
      setEditLoading(false);
    }
  };

  const createSeq = async () => {
    if (!token || !newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/outreach/sequences", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Failed to create");
        return;
      }
      setCreateOpen(false);
      setNotice("Sequence created — edit steps and templates below.");
      await load();
      if (data.sequence?.id) {
        await openEditor(data.sequence.id);
      }
    } finally {
      setCreating(false);
    }
  };

  const saveSequence = async () => {
    if (!token || !editingId) return;
    if (!editName.trim()) {
      setNotice("Name is required");
      return;
    }
    if (editSteps.length === 0) {
      setNotice("Add at least one step");
      return;
    }
    for (let i = 0; i < editSteps.length; i++) {
      const s = editSteps[i];
      if (!s.bodyTemplate.trim()) {
        setNotice(`Step ${i + 1}: message body is required`);
        return;
      }
      if (s.channel === "linkedin" && !s.linkedinAction) {
        setNotice(`Step ${i + 1}: pick LinkedIn action`);
        return;
      }
    }

    setSaving(true);
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
        setNotice(data.error ?? "Save failed");
        return;
      }
      setNotice("Sequence saved.");
      await load();
      if (data.steps) {
        setEditSteps(
          data.steps.map((s: Record<string, unknown>) =>
            mapApiStep({
              channel: String(s.channel),
              mode: String(s.mode),
              delayHours: Number(s.delayHours ?? s.delay_hours ?? 0),
              linkedinAction: (s.linkedinAction ?? s.linkedin_action) as
                | string
                | null,
              subjectTemplate: (s.subjectTemplate ?? s.subject_template) as
                | string
                | null,
              bodyTemplate: String(s.bodyTemplate ?? s.body_template ?? ""),
            }),
          ),
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
          next.mode = "auto";
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
        setNotice(data.error ?? "Enroll failed");
        return;
      }
      setEnrollOpen(false);
      setNotice(
        `Enrolled ${data.enrolled}, skipped ${data.skipped}. LinkedIn tasks appear in the queue.`,
      );
      setTab("queue");
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
        setNotice(data.error ?? "Failed");
        return;
      }
      setNotice(
        outcome === "sent" ? "Marked sent — next step scheduled" : "Skipped",
      );
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
      setNotice("Could not copy");
    }
  };

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  // ── Sequence editor ────────────────────────────────────────────
  if (editingId) {
    return (
      <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditingId(null);
              void load();
            }}
          >
            <ArrowLeft className="size-3.5" />
            All sequences
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEnrollSeqId(editingId);
              setEnrollOpen(true);
            }}
          >
            Enroll from list
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void saveSequence()}>
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Save sequence
          </Button>
        </div>

        {notice && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            {notice}
          </div>
        )}

        {editLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline size-4 animate-spin" />
            Loading sequence…
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-6 overflow-auto pb-10">
            <div className="space-y-3 rounded-lg border p-4">
              <h2 className="text-sm font-medium">Sequence</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <label className="text-xs text-muted-foreground">Name</label>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <label className="text-xs text-muted-foreground">
                    Description (optional)
                  </label>
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="e.g. QA founders warm intro"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Status</label>
                  <Select value={editStatus} onValueChange={setEditStatus}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">draft</SelectItem>
                      <SelectItem value="active">active</SelectItem>
                      <SelectItem value="paused">paused</SelectItem>
                      <SelectItem value="archived">archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end text-xs text-muted-foreground">
                  {enrollmentCount} enrollment(s) loaded · enroll activates
                  draft → active
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">How a step works</p>
                <ul className="mt-1.5 list-inside list-disc space-y-1">
                  <li>
                    <strong>Channel</strong> — LinkedIn or Email (pick per step).
                  </li>
                  <li>
                    <strong>Wait</strong> — pause before this step runs (days +
                    hours after the previous one). Step 1 with 0 = now.
                  </li>
                  <li>
                    <strong>LinkedIn → Add connection</strong> — goes to your
                    human queue: open profile → paste note → send invite → Mark
                    sent.
                  </li>
                  <li>
                    <strong>LinkedIn → Message</strong> — same queue, but DM
                    (after you&apos;re connected).
                  </li>
                  <li>
                    <strong>Email → Auto</strong> — sends alone via Gmail in
                    Settings. <strong>Semi</strong> = you approve/send manually.
                  </li>
                  <li>
                    <strong>Message box</strong> — edit the exact text/template
                    for that step. {TOKEN_HINT}
                  </li>
                </ul>
              </div>

              {/* Cadence preview */}
              <div className="rounded-lg border p-3">
                <p className="mb-2 text-xs font-medium">Cadence preview</p>
                <ol className="space-y-1 text-xs text-muted-foreground">
                  {editSteps.map((s, i) => (
                    <li key={s.key} className="flex flex-wrap gap-x-2">
                      <span className="font-medium text-foreground">
                        {i + 1}.
                      </span>
                      <span>
                        {s.channel === "linkedin"
                          ? s.linkedinAction === "connect_note"
                            ? "LinkedIn · Add connection + note"
                            : "LinkedIn · Message"
                          : s.mode === "auto"
                            ? "Email · auto-send"
                            : "Email · semi"}
                      </span>
                      <span>· {formatWait(s.delayHours)}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-medium">
                    Steps — channel, wait, action, message
                  </h2>
                  <p className="text-xs text-muted-foreground">{TOKEN_HINT}</p>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditSteps((p) => [...p, blankStep("linkedin")])
                    }
                  >
                    <Plus className="size-3.5" />
                    Add LinkedIn
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditSteps((p) => [...p, blankStep("email")])
                    }
                  >
                    <Plus className="size-3.5" />
                    Add Email
                  </Button>
                </div>
              </div>

              {editSteps.map((step, idx) => {
                const waitDays = Math.floor(step.delayHours / 24);
                const waitHours = step.delayHours % 24;
                const setWait = (days: number, hours: number) => {
                  updateStep(step.key, {
                    delayHours: Math.max(0, days) * 24 + Math.max(0, hours),
                  });
                };
                const move = (dir: -1 | 1) => {
                  setEditSteps((prev) => {
                    const i = prev.findIndex((x) => x.key === step.key);
                    const j = i + dir;
                    if (i < 0 || j < 0 || j >= prev.length) return prev;
                    const next = [...prev];
                    [next[i], next[j]] = [next[j], next[i]];
                    return next;
                  });
                };

                return (
                  <div
                    key={step.key}
                    className="space-y-4 rounded-lg border bg-card p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">Step {idx + 1}</Badge>
                        <Badge variant="outline">
                          {step.channel === "linkedin" ? "LinkedIn" : "Email"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatWait(step.delayHours)}
                          {step.channel === "linkedin"
                            ? " · you send from queue"
                            : step.mode === "auto"
                              ? " · auto via Gmail"
                              : " · you send"}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={idx === 0}
                          onClick={() => move(-1)}
                          title="Move up"
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={idx === editSteps.length - 1}
                          onClick={() => move(1)}
                          title="Move down"
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={editSteps.length <= 1}
                          onClick={() =>
                            setEditSteps((p) =>
                              p.filter((x) => x.key !== step.key),
                            )
                          }
                        >
                          <Trash2 className="size-3.5" />
                          Remove
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="text-xs font-medium">
                          1. Channel (LinkedIn or Email)
                        </label>
                        <Select
                          value={step.channel}
                          onValueChange={(v) =>
                            updateStep(step.key, {
                              channel: v as "email" | "linkedin",
                            })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="linkedin">
                              LinkedIn
                            </SelectItem>
                            <SelectItem value="email">Email</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {step.channel === "linkedin" ? (
                        <div className="space-y-1">
                          <label className="text-xs font-medium">
                            2. LinkedIn action
                          </label>
                          <Select
                            value={step.linkedinAction ?? "connect_note"}
                            onValueChange={(v) =>
                              updateStep(step.key, {
                                linkedinAction: v as
                                  | "connect_note"
                                  | "message",
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="connect_note">
                                Add connection + note (invite)
                              </SelectItem>
                              <SelectItem value="message">
                                Message (DM after connected)
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[11px] text-muted-foreground">
                            Appears in LinkedIn queue: open profile → copy note
                            → you send on LinkedIn → Mark sent.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <label className="text-xs font-medium">
                            2. How email is sent
                          </label>
                          <Select
                            value={step.mode}
                            onValueChange={(v) =>
                              updateStep(step.key, {
                                mode: v as "auto" | "semi",
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">
                                Auto — Gmail mailbox sends
                              </SelectItem>
                              <SelectItem value="semi">
                                Semi — queue for you to send
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium">
                        3. Wait before this step
                        {idx === 0
                          ? " (from enroll)"
                          : " (after previous step is done)"}
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={0}
                            className="w-20"
                            value={waitDays}
                            onChange={(e) =>
                              setWait(Number(e.target.value) || 0, waitHours)
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            days
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={0}
                            max={23}
                            className="w-20"
                            value={waitHours}
                            onChange={(e) =>
                              setWait(waitDays, Number(e.target.value) || 0)
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            hours
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          = {formatWait(step.delayHours)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {[
                          [0, "Now"],
                          [24, "1 day"],
                          [48, "2 days"],
                          [72, "3 days"],
                          [168, "1 week"],
                        ].map(([h, label]) => (
                          <Button
                            key={String(h)}
                            type="button"
                            size="sm"
                            variant={
                              step.delayHours === h ? "default" : "outline"
                            }
                            className="h-7 text-xs"
                            onClick={() =>
                              updateStep(step.key, {
                                delayHours: h as number,
                              })
                            }
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>

                    {step.channel === "email" && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium">
                          4. Email subject
                        </label>
                        <Input
                          value={step.subjectTemplate}
                          onChange={(e) =>
                            updateStep(step.key, {
                              subjectTemplate: e.target.value,
                            })
                          }
                          placeholder="QA at {{company}}"
                        />
                      </div>
                    )}

                    <div className="space-y-1">
                      <label className="text-xs font-medium">
                        {step.channel === "linkedin"
                          ? step.linkedinAction === "connect_note"
                            ? "4. Connection note text (what you paste on LinkedIn)"
                            : "4. LinkedIn message text"
                          : "5. Email body"}
                      </label>
                      <Textarea
                        value={step.bodyTemplate}
                        onChange={(e) =>
                          updateStep(step.key, {
                            bodyTemplate: e.target.value,
                          })
                        }
                        rows={step.channel === "email" ? 8 : 5}
                        className="min-h-[100px] text-sm leading-relaxed"
                        placeholder={
                          step.channel === "linkedin"
                            ? "Hey {{first_name}} — …"
                            : "Hi {{first_name}},\n\n…"
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Enroll research list</DialogTitle>
              <DialogDescription>
                People from the list enter this sequence. First due step goes to
                the LinkedIn queue or sends email.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Research list
              </label>
              <Select value={enrollTableId} onValueChange={setEnrollTableId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick list" />
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
            <DialogFooter>
              <Button variant="outline" onClick={() => setEnrollOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={enrolling || !enrollTableId}
                onClick={() => void enroll()}
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
      </div>
    );
  }

  // ── List + queue ───────────────────────────────────────────────
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sequences</h1>
          <p className="text-sm text-muted-foreground">
            Build multi-step cadences (LinkedIn + email templates), enroll
            lists, work the LinkedIn queue. Email sends from{" "}
            <a href="/settings" className="underline underline-offset-2">
              Settings → mailbox
            </a>
            .
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEnrollOpen(true)}
          >
            Enroll from list
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New sequence
          </Button>
        </div>
      </div>

      {!mailboxConfigured && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          No outreach mailbox configured — email steps won&apos;t send until you
          connect Gmail in{" "}
          <a
            href="/settings"
            className="font-medium underline underline-offset-2"
          >
            Settings
          </a>
          . LinkedIn queue still works.
        </div>
      )}

      {notice && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          {notice}
        </div>
      )}

      <div className="flex gap-1 border-b">
        {(
          [
            ["sequences", `Sequences (${sequences.length})`],
            ["queue", `LinkedIn queue (${tasks.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm",
              tab === id
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "queue" && (
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && tasks.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Loading queue…
            </div>
          ) : tasks.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              No LinkedIn tasks ready. Open a sequence, edit templates, enroll a
              list, then work tasks here.
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map((t) => {
                const e = t.enrollment;
                const profile =
                  (t.meta?.profile_url as string) ||
                  e?.contactLinkedin ||
                  null;
                const action = t.step?.linkedinAction ?? "message";
                return (
                  <div
                    key={t.id}
                    className="rounded-lg border bg-card p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium">
                          {e?.contactName ?? "—"}{" "}
                          <span className="font-normal text-muted-foreground">
                            @ {e?.companyName}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {e?.contactRole && <span>{e.contactRole}</span>}
                          {e?.domain && (
                            <span className="font-mono">{e.domain}</span>
                          )}
                          <Badge variant="secondary" className="text-[10px]">
                            {action === "connect_note"
                              ? "Connect note"
                              : "Message"}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {profile && (
                          <Button size="sm" variant="outline" asChild>
                            <a
                              href={profile}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink className="size-3.5" />
                              Open LinkedIn
                            </a>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void copyText(t.renderedBody ?? "")}
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
                          Mark sent
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
                    <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm leading-relaxed">
                      {t.renderedBody}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "sequences" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Active enrollments</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((s) => (
                <TableRow
                  key={s.id}
                  className="cursor-pointer"
                  onClick={() => void openEditor(s.id)}
                >
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.status}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {s.stepCount ?? "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {s.enrollmentCount ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        void openEditor(s.id);
                      }}
                    >
                      Edit steps
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {sequences.length === 0 && !loading && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No sequences yet. Create one to edit steps and templates.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">
            Click a row or <strong>Edit steps</strong> to set channel per step
            (LinkedIn / Email), wait time, connection vs message, and the full
            template text — then Save.
          </p>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New sequence</DialogTitle>
            <DialogDescription>
              Starts with a default 3-step cadence. You can change every step
              and template right after create.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Sequence name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void createSeq();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button disabled={creating} onClick={() => void createSeq()}>
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Create & edit"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll research list</DialogTitle>
            <DialogDescription>
              Enrolls people into a sequence. Edit templates first if needed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Sequence</label>
              <Select value={enrollSeqId} onValueChange={setEnrollSeqId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick sequence" />
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
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Research list
              </label>
              <Select value={enrollTableId} onValueChange={setEnrollTableId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick list" />
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
            <Button variant="outline" onClick={() => setEnrollOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={enrolling || !enrollSeqId || !enrollTableId}
              onClick={() => void enroll()}
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
    </div>
  );
}
