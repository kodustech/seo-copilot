"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/markdown-content";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { Empty, SectionLabel, Status, authHeaders, cls, fmtWhen, type Persona, type Tone } from "./shared";

type AgentSession = {
  id: string;
  trigger: string;
  goal: string;
  status: "running" | "completed" | "failed";
  result_summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type SessionStep = {
  id: string;
  idx: number;
  kind: string;
  tool: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

const SESSION_TONE: Record<AgentSession["status"], Tone> = {
  running: "warn",
  completed: "good",
  failed: "bad",
};

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: "shift",
  manual: "task",
  reactive: "reaction",
};

/** The first sentence of a shift brief is the only part worth reading in a
 *  list; the rest is the same instructions every time. */
function briefHeadline(goal: string): string {
  const firstLine = goal.split("\n")[0] ?? goal;
  const sentence = firstLine.split(/(?<=\.)\s/)[0] ?? firstLine;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
}

/** Whether four clamped lines could hide part of this summary: long text,
 *  or short text spread over several lines (a list, a heading, a code block).
 *  Measuring the clamp after render would be exact; this errs on showing the
 *  toggle, which costs one idle button and never a hidden paragraph. */
function needsToggle(summary: string): boolean {
  return summary.length > 280 || summary.split("\n").filter((l) => l.trim()).length > 3;
}

/**
 * Runs: a composer for a one-off task, then the sessions as a ledger. A
 * scheduled shift's brief is the same wall of instructions every time, so
 * the row shows what the run produced and keeps the brief behind a toggle.
 */
export function RunsTab({ token, persona, onChanged }: { token: string; persona: Persona; onChanged: () => void }) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState<Record<string, boolean>>({});
  const [summaryOpen, setSummaryOpen] = useState<Record<string, boolean>>({});
  const [steps, setSteps] = useState<Record<string, SessionStep[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/agent`, { headers: authHeaders(token) });
      const body = await res.json();
      if (res.ok) setSessions(body.sessions ?? []);
    } finally {
      setLoading(false);
    }
  }, [token, persona.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function runTask() {
    if (!goal.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/agent`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ goal: goal.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Run failed");
      setGoal("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function toggleTrace(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (!steps[id]) {
      const res = await fetch(`/api/influencers/sessions/${id}`, { headers: authHeaders(token) });
      const body = await res.json();
      if (res.ok) setSteps((prev) => ({ ...prev, [id]: body.steps ?? [] }));
    }
  }

  return (
    <div className="space-y-5">
      <section className={cn(cls.panel, "space-y-2 p-4")}>
        <SectionLabel hint="It works with its own tools and model and queues drafts for review. It never publishes directly.">
          Give it a task
        </SectionLabel>
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          placeholder="e.g. Review the latest changes in facebook/react and write a tweet on what stood out."
          className={cls.textarea}
        />
        {error ? <p className={cls.errorText}>{error}</p> : null}
        <div>
          <button type="button" onClick={runTask} disabled={running || !goal.trim()} className={cls.primary}>
            {running ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Working…
              </>
            ) : (
              "Run task"
            )}
          </button>
        </div>
      </section>

      <section>
        <SectionLabel hint={sessions.length ? `${sessions.length} most recent` : undefined}>Runs</SectionLabel>
        {loading ? (
          <Skeleton className="h-24 bg-white/[0.04]" />
        ) : sessions.length === 0 ? (
          <Empty>No runs yet. Give it a task above, or turn autonomy on in the Plan tab.</Empty>
        ) : (
          <div className={cn(cls.panel, "divide-y divide-white/[0.06]")}>
            {sessions.map((s) => {
              const showBrief = briefOpen[s.id] ?? false;
              const isScheduled = s.trigger === "scheduled";
              return (
                <article key={s.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                    <Status tone={SESSION_TONE[s.status]}>{s.status}</Status>
                    <span className="text-neutral-400">{TRIGGER_LABEL[s.trigger] ?? s.trigger}</span>
                    <span className="ml-auto tabular-nums">{fmtWhen(s.started_at)}</span>
                  </div>

                  {isScheduled ? (
                    <button
                      type="button"
                      onClick={() => setBriefOpen((m) => ({ ...m, [s.id]: !showBrief }))}
                      className="flex items-start gap-1.5 text-left text-sm text-neutral-300 hover:text-neutral-100"
                    >
                      {showBrief ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-neutral-500" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-neutral-500" />}
                      <span>{showBrief ? "Shift brief" : briefHeadline(s.goal)}</span>
                    </button>
                  ) : (
                    <p className="text-sm text-neutral-100">{s.goal}</p>
                  )}
                  {isScheduled && showBrief ? (
                    <p className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-white/[0.06] bg-neutral-950/60 p-3 text-xs leading-relaxed text-neutral-400">
                      {s.goal}
                    </p>
                  ) : null}

                  {s.result_summary ? (
                    // The persona writes its summary in markdown; shown as such,
                    // and clipped to a few lines until asked for the whole thing.
                    <div>
                      <MarkdownContent
                        text={s.result_summary}
                        className={cn(!(summaryOpen[s.id] ?? false) && "line-clamp-4")}
                      />
                      {needsToggle(s.result_summary) ? (
                        <button
                          type="button"
                          onClick={() => setSummaryOpen((m) => ({ ...m, [s.id]: !(m[s.id] ?? false) }))}
                          className="mt-1 text-xs text-neutral-500 hover:text-neutral-200"
                        >
                          {summaryOpen[s.id] ? "Less" : "More"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {s.error ? <p className={cls.errorText}>{s.error}</p> : null}

                  <button type="button" onClick={() => toggleTrace(s.id)} className="text-xs text-neutral-500 hover:text-neutral-200">
                    {openId === s.id ? "Hide trace" : "Show trace"}
                  </button>
                  {openId === s.id ? (
                    <ol className="max-h-96 space-y-1 overflow-y-auto rounded-md border border-white/[0.06] bg-neutral-950/60 p-3 font-mono text-[11px] leading-relaxed">
                      {(steps[s.id] ?? []).map((step) => (
                        <li key={step.id} className="grid grid-cols-[28px_minmax(0,160px)_minmax(0,1fr)] gap-2">
                          <span className="tabular-nums text-neutral-600">{step.idx}</span>
                          <span className="truncate text-neutral-300">{step.tool ? `${step.kind}:${step.tool}` : step.kind}</span>
                          <span className="truncate text-neutral-500">{JSON.stringify(step.payload).slice(0, 200)}</span>
                        </li>
                      ))}
                      {(steps[s.id]?.length ?? 0) === 0 ? <li className="text-neutral-600">No steps.</li> : null}
                    </ol>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
