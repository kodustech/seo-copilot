"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  SkipForward,
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

export function SequencesPage() {
  const token = useAuthToken();
  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const [tab, setTab] = useState<"queue" | "sequences">("queue");
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [tables, setTables] = useState<ResearchTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      setNotice(`Sequence created: ${data.sequence?.name}`);
      await load();
    } finally {
      setCreating(false);
    }
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
      setNotice(outcome === "sent" ? "Marked sent — next step scheduled" : "Skipped");
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

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sequences</h1>
          <p className="text-sm text-muted-foreground">
            Multi-step outreach: LinkedIn semi-auto queue + email auto (Resend
            in next PR). Enroll from research lists or outreach prospects.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEnrollOpen(true)}>
            Enroll from list
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New sequence
          </Button>
        </div>
      </div>

      {notice && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          {notice}
        </div>
      )}

      <div className="flex gap-1 border-b">
        {(
          [
            ["queue", `LinkedIn queue (${tasks.length})`],
            ["sequences", `Sequences (${sequences.length})`],
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
              No LinkedIn tasks ready. Create a sequence, enroll a research
              list, then come back here to send connect notes / messages.
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
                          onClick={() =>
                            void copyText(t.renderedBody ?? "")
                          }
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((s) => (
                <TableRow key={s.id}>
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
                </TableRow>
              ))}
              {sequences.length === 0 && !loading && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No sequences yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New sequence</DialogTitle>
            <DialogDescription>
              Creates a default cadence: LinkedIn connect note (semi) → email
              (auto) → LinkedIn follow-up (semi).
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Sequence name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button disabled={creating} onClick={() => void createSeq()}>
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Create"
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
              Enrolls every person on companies in the list (or company row if
              no people). First step tasks go to the LinkedIn queue.
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
