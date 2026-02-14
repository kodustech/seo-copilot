"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Plus,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight,
  Calendar,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PRESETS = [
  { value: "daily_9am", label: "Diariamente as 9h" },
  { value: "weekly_monday", label: "Toda segunda as 9h" },
  { value: "weekly_friday", label: "Toda sexta as 9h" },
  { value: "biweekly", label: "Quinzenalmente" },
  { value: "monthly_first", label: "Mensalmente" },
];

type Job = {
  id: string;
  name: string;
  prompt: string;
  cron_expression: string;
  webhook_url: string;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
};

type JobRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  result_summary: string | null;
  error: string | null;
  webhook_status: number | null;
};

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  return token;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function presetLabel(cron: string): string {
  const map: Record<string, string> = {
    "0 9 * * *": "Diariamente as 9h",
    "0 9 * * 1": "Toda segunda as 9h",
    "0 9 * * 5": "Toda sexta as 9h",
    "0 9 1,15 * *": "Quinzenalmente",
    "0 9 1 * *": "Mensalmente",
  };
  return map[cron] ?? cron;
}

export function JobsPage() {
  const token = useAuthToken();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, JobRun[]>>({});
  const [runsLoading, setRunsLoading] = useState<Record<string, boolean>>({});

  // Create form state
  const [formName, setFormName] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formSchedule, setFormSchedule] = useState("weekly_monday");
  const [formWebhook, setFormWebhook] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);

  const fetchJobs = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/jobs", { headers: authHeaders(token) });
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  async function handleCreate() {
    if (!token || !formName || !formPrompt || !formWebhook) return;
    setFormSubmitting(true);
    try {
      await fetch("/api/jobs", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          name: formName,
          prompt: formPrompt,
          schedule: formSchedule,
          webhook_url: formWebhook,
        }),
      });
      setDialogOpen(false);
      setFormName("");
      setFormPrompt("");
      setFormSchedule("weekly_monday");
      setFormWebhook("");
      fetchJobs();
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleToggle(job: Job) {
    if (!token) return;
    const newEnabled = !job.enabled;
    // Optimistic update
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, enabled: newEnabled } : j)),
    );
    await fetch(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ enabled: newEnabled }),
    });
  }

  async function handleDelete(jobId: string) {
    if (!token) return;
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    await fetch(`/api/jobs/${jobId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
  }

  async function toggleRuns(jobId: string) {
    if (expandedJob === jobId) {
      setExpandedJob(null);
      return;
    }
    setExpandedJob(jobId);
    if (runs[jobId]) return;

    setRunsLoading((p) => ({ ...p, [jobId]: true }));
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        headers: authHeaders(token!),
      });
      const data = await res.json();
      setRuns((p) => ({ ...p, [jobId]: data.runs ?? [] }));
    } finally {
      setRunsLoading((p) => ({ ...p, [jobId]: false }));
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Scheduled Jobs</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Tarefas que executam automaticamente e enviam resultado via webhook.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-lg bg-violet-600 text-white hover:bg-violet-500">
              <Plus className="mr-2 h-4 w-4" />
              Novo Job
            </Button>
          </DialogTrigger>
          <DialogContent className="border-white/10 bg-neutral-950 text-white sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Novo Job Agendado</DialogTitle>
              <DialogDescription className="text-neutral-400">
                Configure o prompt, frequencia e webhook de destino.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-400">
                  Nome
                </label>
                <Input
                  placeholder="Relatorio SEO Semanal"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="border-white/10 bg-neutral-900 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-400">
                  Prompt
                </label>
                <Textarea
                  placeholder="Analise a performance de SEO da ultima semana e gere um relatorio..."
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  rows={4}
                  className="border-white/10 bg-neutral-900 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-400">
                  Frequencia
                </label>
                <Select value={formSchedule} onValueChange={setFormSchedule}>
                  <SelectTrigger className="border-white/10 bg-neutral-900 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-white/10 bg-neutral-900 text-white">
                    {PRESETS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-400">
                  Webhook URL
                </label>
                <Input
                  placeholder="https://hooks.slack.com/..."
                  value={formWebhook}
                  onChange={(e) => setFormWebhook(e.target.value)}
                  className="border-white/10 bg-neutral-900 text-white"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleCreate}
                disabled={formSubmitting || !formName || !formPrompt || !formWebhook}
                className="rounded-lg bg-violet-600 text-white hover:bg-violet-500"
              >
                {formSubmitting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                Criar Job
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Jobs list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-500" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] py-16">
          <Calendar className="h-10 w-10 text-neutral-700" />
          <p className="text-sm text-neutral-500">
            Nenhum job agendado ainda.
          </p>
          <p className="text-xs text-neutral-600">
            Crie pelo botao acima ou pelo chat do Atlas.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="rounded-xl border border-white/[0.06] bg-white/[0.03]"
            >
              {/* Job row */}
              <div className="flex items-center gap-4 px-4 py-3">
                <Switch
                  checked={job.enabled}
                  onCheckedChange={() => handleToggle(job)}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-neutral-200">
                    {job.name}
                  </p>
                  <p className="text-[11px] text-neutral-500">
                    {presetLabel(job.cron_expression)}
                    {job.last_run_at && (
                      <>
                        {" "}· Ultimo run:{" "}
                        {new Date(job.last_run_at).toLocaleDateString("pt-BR", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </>
                    )}
                  </p>
                </div>
                <span
                  className="max-w-[160px] truncate font-mono text-[10px] text-neutral-600"
                  title={job.webhook_url}
                >
                  {job.webhook_url}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-neutral-500 hover:bg-white/10 hover:text-neutral-300"
                  onClick={() => toggleRuns(job.id)}
                >
                  {expandedJob === job.id ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-400/60 hover:bg-red-500/10 hover:text-red-400"
                  onClick={() => handleDelete(job.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {/* Expanded runs */}
              {expandedJob === job.id && (
                <div className="border-t border-white/[0.06] px-4 py-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                    Prompt
                  </p>
                  <p className="mb-3 text-xs leading-relaxed text-neutral-400">
                    {job.prompt}
                  </p>

                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                    Historico de execucoes
                  </p>
                  {runsLoading[job.id] ? (
                    <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
                  ) : !runs[job.id]?.length ? (
                    <p className="text-xs text-neutral-600">
                      Nenhuma execucao ainda.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {runs[job.id].map((run) => (
                        <div
                          key={run.id}
                          className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                        >
                          <div className="flex items-center gap-2">
                            <Badge
                              className={`text-[10px] ${
                                run.status === "completed"
                                  ? "border-emerald-500/30 bg-emerald-500/20 text-emerald-400"
                                  : run.status === "failed"
                                    ? "border-red-500/30 bg-red-500/20 text-red-400"
                                    : "border-yellow-500/30 bg-yellow-500/20 text-yellow-400"
                              }`}
                            >
                              {run.status}
                            </Badge>
                            <span className="text-[11px] tabular-nums text-neutral-500">
                              {new Date(run.started_at).toLocaleDateString(
                                "pt-BR",
                                {
                                  day: "2-digit",
                                  month: "short",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </span>
                            {run.webhook_status !== null && run.webhook_status > 0 && (
                              <span className="text-[10px] text-neutral-600">
                                webhook: {run.webhook_status}
                              </span>
                            )}
                          </div>
                          {run.result_summary && (
                            <p className="mt-1.5 text-xs leading-relaxed text-neutral-400 line-clamp-3">
                              {run.result_summary}
                            </p>
                          )}
                          {run.error && (
                            <p className="mt-1.5 text-xs text-red-400/80">
                              {run.error}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
