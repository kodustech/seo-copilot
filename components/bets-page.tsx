"use client";

/* Hallmark · genre: modern-minimal · macrostructure: Workbench (app page: verdicts board grouped by lever) · theme: app tokens (dark neutral, violet ≤ 5%) · enrichment: none · nav: app shell · footer: none */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, FlaskConical, Link2, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";

import type { BetEvaluation, EvaluationLevel } from "@/lib/bet-evaluation";
import type { Bet, BetEntry, BetEntryKind, BetMeasure, BetStatus, MeasureKind } from "@/lib/bets";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Types the API returns
// ---------------------------------------------------------------------------

type BetRow = Bet & {
  goalTitle: string | null;
  goalPeriod: string | null;
  goalFunnelMetric: string | null;
  evaluation: BetEvaluation | null;
  entries: BetEntry[];
};

const ENTRY_KIND_LABEL: Record<BetEntryKind, string> = { note: "note", artifact: "artifact", result: "result", decision: "decision" };

/** The journal of a bet: what was done, with dates and links, plus the box to add to it. */
function Journal({ bet, headers, onChanged }: { bet: BetRow; headers: Record<string, string>; onChanged: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<BetEntryKind>("note");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/bets/${bet.id}/entries`, { method: "POST", headers, body: JSON.stringify({ text, url: url || null, kind, happenedOn: when || null }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setText("");
      setUrl("");
      setWhen("");
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm("Delete this entry?")) return;
    setErr(null);
    try {
      const res = await fetch(`/api/bet-entries/${id}`, { method: "DELETE", headers });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Failed");
      }
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-neutral-500">Journal · what was done</p>
      {bet.entries.length ? (
        <ol className="mt-1 divide-y divide-white/[0.06]">
          {bet.entries.map((e) => (
            <li key={e.id} className="group/entry flex items-start gap-3 py-1.5 text-sm">
              <span className="w-[76px] shrink-0 text-[11px] tabular-nums text-neutral-500">{e.happenedOn}</span>
              <span className="min-w-0 flex-1">
                <span className="text-neutral-200">{e.text}</span>
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-xs text-sky-300 hover:underline">
                    <Link2 className="size-3" /> {e.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}
                  </a>
                ) : null}
                <span className="ml-2 text-[11px] text-neutral-600">
                  {ENTRY_KIND_LABEL[e.kind]}
                  {e.authorEmail ? ` · ${e.authorEmail.split("@")[0]}` : ""}
                </span>
              </span>
              <button type="button" onClick={() => remove(e.id)} aria-label="Delete entry" className="opacity-0 transition-opacity group-hover/entry:opacity-100 text-neutral-600 hover:text-red-300">
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-1 text-xs text-neutral-500">Nothing logged yet. Write what was done, with a link when there is one: an article, a sequence, a list, a page.</p>
      )}
      <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_110px_128px_auto]">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Published 3 articles on devtools-weekly.com" className="h-8 border-white/10 bg-neutral-950 text-xs" onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) void add(); }} />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (optional)" className="h-8 border-white/10 bg-neutral-950 text-xs" />
        <Select value={kind} onValueChange={(v) => setKind(v as BetEntryKind)}>
          <SelectTrigger className="h-8 border-white/10 bg-neutral-950 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={menuCls}>
            <SelectItem value="note">note</SelectItem>
            <SelectItem value="artifact">artifact</SelectItem>
            <SelectItem value="result">result</SelectItem>
            <SelectItem value="decision">decision</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8 border-white/10 bg-neutral-950 text-xs" title="When it happened (default today)" />
        <button type="button" onClick={add} disabled={busy || !text.trim()} className="h-8 rounded-md bg-white/[0.08] px-3 text-xs text-neutral-100 hover:bg-white/[0.12] disabled:opacity-40">
          {busy ? "…" : "Log"}
        </button>
      </div>
      {err ? <p className="mt-1 text-xs text-red-300">{err}</p> : null}
    </div>
  );
}

type GoalOption = { id: string; title: string; periodStart: string; periodEnd: string; funnelMetric: string | null };

type Options = {
  funnelStages: { id: string; label: string; unit: string }[];
  funnelRates: { id: string; label: string }[];
  assistants: { id: string; label: string }[];
  sequenceTags: string[];
  workItems: { id: string; title: string; stage: string | null }[];
  levers: string[];
  owners: string[];
};

const STATUS_LABEL: Record<BetStatus, { label: string; className: string }> = {
  queued: { label: "queued", className: "bg-neutral-500/15 text-neutral-300 ring-1 ring-inset ring-white/10" },
  active: { label: "active", className: "bg-emerald-500/15 text-emerald-300" },
  won: { label: "won", className: "bg-sky-500/15 text-sky-300" },
  lost: { label: "lost", className: "bg-red-500/15 text-red-300" },
  operation: { label: "became operation", className: "bg-violet-500/15 text-violet-300" },
};

const KIND_LABEL: Record<MeasureKind, string> = {
  funnel_stage: "Funnel stage",
  funnel_rate: "Funnel rate",
  ai_share: "AI visibility share",
  outbound_tag: "Sequences with a tag",
  manual: "Typed by hand",
};

const LEVEL_STYLE: Record<EvaluationLevel["status"], { dot: string; text: string }> = {
  yes: { dot: "bg-emerald-400", text: "text-emerald-300" },
  partial: { dot: "bg-amber-400", text: "text-amber-300" },
  no: { dot: "bg-red-400/80", text: "text-neutral-400" },
  unknown: { dot: "bg-transparent ring-1 ring-inset ring-white/25", text: "text-neutral-500" },
};

function isRate(m: BetMeasure | null): boolean {
  return Boolean(m && (m.kind === "funnel_rate" || m.kind === "ai_share" || (m.kind === "outbound_tag" && m.submetric === "reply_rate")));
}

function fmt(v: number | null | undefined, rate: boolean): string {
  if (v == null) return "–";
  return rate ? `${Math.round(v * 1000) / 10}%` : Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function daysLabel(n: number, decisionAt: string, status: BetStatus): { text: string; tone: string } {
  if (status !== "active" && status !== "queued") return { text: `decided · due ${decisionAt}`, tone: "text-neutral-500" };
  if (n === 0) return { text: "decide today", tone: "text-amber-300" };
  if (decisionAt < new Date().toISOString().slice(0, 10)) return { text: `past due (${decisionAt})`, tone: "text-amber-300" };
  return { text: `${n} day${n === 1 ? "" : "s"} left`, tone: n <= 3 ? "text-amber-300" : "text-neutral-400" };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SectionHeader({ label, hint, right }: { label: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 pb-2 pt-1">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{label}</h2>
      {hint ? <p className="hidden text-[11px] text-neutral-600 sm:block">{hint}</p> : null}
      <div className="h-px flex-1 bg-white/[0.06]" />
      {right}
    </div>
  );
}

function Levels({ ev, compact }: { ev: BetEvaluation | null; compact?: boolean }) {
  const list = ev ? [ev.levels.action, ev.levels.metric, ev.levels.opportunities] : null;
  const short = ["Action", "Metric", "Opportunities"];
  return (
    <div className={cn("flex items-center gap-3", compact ? "text-[11px]" : "text-xs")}>
      {short.map((label, i) => {
        const lv = list?.[i];
        const st = LEVEL_STYLE[lv?.status ?? "unknown"];
        return (
          <span key={label} className="inline-flex items-center gap-1.5" title={lv?.detail ?? "Not evaluated"}>
            <span className={cn("inline-block size-2 rounded-full", st.dot)} />
            <span className={st.text}>{label}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The number that proves it, against its threshold. */
function MeasureBlock({ bet }: { bet: BetRow }) {
  const ev = bet.evaluation;
  const m = bet.measure;
  if (!m) {
    return (
      <div className="text-xs text-neutral-500">
        <p className="text-neutral-400">{bet.metric}</p>
        <p className="mt-0.5">No measure yet. Add one so the number is read automatically.</p>
      </div>
    );
  }
  const rate = isRate(m);
  const current = ev?.current ?? null;
  const threshold = ev?.threshold ?? m.threshold;
  const pct = ev?.progress != null ? Math.round(ev.progress * 100) : null;
  const met = ev?.met ?? null;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className={cn("text-2xl font-semibold tabular-nums tracking-tight", met ? "text-emerald-300" : current == null ? "text-neutral-500" : "text-neutral-100")}>{fmt(current, rate)}</span>
        <span className="text-xs text-neutral-500">
          {m.comparator} {fmt(threshold, rate)}
          {ev?.previous != null ? ` · before ${fmt(ev.previous, rate)}` : ""}
        </span>
      </div>
      {pct != null ? (
        <div className="mt-1.5 h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
          <div className={cn("h-full rounded-full", met ? "bg-emerald-400/80" : "bg-neutral-400/60")} style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%` }} />
        </div>
      ) : null}
      <p className="mt-1 truncate text-[11px] text-neutral-500" title={ev?.source ?? undefined}>
        {KIND_LABEL[m.kind]} · {ev?.source || bet.metric}
      </p>
      {ev?.errors.length ? <p className="mt-0.5 text-[11px] text-amber-300">{ev.errors[0]}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bet form (create / edit)
// ---------------------------------------------------------------------------

type FormState = {
  goalId: string;
  title: string;
  lever: string;
  ownerEmail: string;
  hypothesis: string;
  action: string;
  metric: string;
  decisionAt: string;
  status: BetStatus;
  kanbanItemId: string;
  notes: string;
  measureKind: MeasureKind | "none";
  measureId: string;
  submetric: "contacts" | "replies" | "reply_rate" | "meetings";
  comparator: ">=" | "<=";
  threshold: string;
  windowStart: string;
  windowEnd: string;
  currentValue: string;
};

const EMPTY: FormState = {
  goalId: "",
  title: "",
  lever: "",
  ownerEmail: "",
  hypothesis: "",
  action: "",
  metric: "",
  decisionAt: "",
  status: "active",
  kanbanItemId: "",
  notes: "",
  measureKind: "none",
  measureId: "",
  submetric: "replies",
  comparator: ">=",
  threshold: "",
  windowStart: "",
  windowEnd: "",
  currentValue: "",
};

function fromBet(b: BetRow): FormState {
  return {
    goalId: b.goalId,
    title: b.title,
    lever: b.lever ?? "",
    ownerEmail: b.ownerEmail ?? "",
    hypothesis: b.hypothesis,
    action: b.action,
    metric: b.metric,
    decisionAt: b.decisionAt,
    status: b.status,
    kanbanItemId: b.kanbanItemId ?? "",
    notes: b.notes ?? "",
    measureKind: b.measure?.kind ?? "none",
    measureId: b.measure?.id ?? "",
    submetric: b.measure?.submetric ?? "replies",
    comparator: b.measure?.comparator ?? ">=",
    threshold: b.measure ? String(isRate(b.measure) ? Math.round(b.measure.threshold * 1000) / 10 : b.measure.threshold) : "",
    windowStart: b.measure?.window?.start ?? "",
    windowEnd: b.measure?.window?.end ?? "",
    currentValue: b.currentValue == null ? "" : String(b.currentValue),
  };
}

function toPayload(f: FormState, mode: "create" | "edit"): Record<string, unknown> {
  const rate = f.measureKind === "funnel_rate" || f.measureKind === "ai_share" || (f.measureKind === "outbound_tag" && f.submetric === "reply_rate");
  const threshold = Number(f.threshold);
  const measure =
    f.measureKind === "none" || !f.measureId.trim() || !Number.isFinite(threshold)
      ? null
      : {
          kind: f.measureKind,
          id: f.measureId.trim(),
          ...(f.measureKind === "outbound_tag" ? { submetric: f.submetric } : {}),
          comparator: f.comparator,
          threshold: rate ? threshold / 100 : threshold,
          ...(f.windowStart && f.windowEnd ? { window: { start: f.windowStart, end: f.windowEnd } } : { window: null }),
        };
  return {
    goalId: f.goalId,
    title: f.title,
    lever: f.lever || null,
    ownerEmail: f.ownerEmail || null,
    hypothesis: f.hypothesis,
    action: f.action,
    metric: f.metric,
    decisionAt: f.decisionAt,
    // Editing never changes the status: a decided bet stays decided; use
    // the decide buttons for that.
    ...(mode === "create" ? { status: f.status } : {}),
    kanbanItemId: f.kanbanItemId || null,
    notes: f.notes || null,
    measure,
    currentValue: f.measureKind === "manual" && f.currentValue !== "" ? Number(f.currentValue) : null,
  };
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-neutral-600">{hint}</span> : null}
    </label>
  );
}

const inputCls = "h-9 border-white/10 bg-neutral-900 text-sm";
const selectCls = "h-9 w-full min-w-0 border-white/10 bg-neutral-900 text-sm [&>span]:truncate";
const menuCls = "border-white/10 bg-neutral-950 text-neutral-200";

function BetDialog({
  open,
  onOpenChange,
  initial,
  goals,
  options,
  onSubmit,
  saving,
  title,
  mode,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: FormState;
  goals: GoalOption[];
  options: Options | null;
  onSubmit: (payload: Record<string, unknown>) => Promise<boolean>;
  saving: boolean;
  title: string;
  mode: "create" | "edit";
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto border-white/10 bg-neutral-950 text-neutral-100">
        <BetForm key={`${open}:${initial.goalId}:${initial.title}`} initial={initial} goals={goals} options={options} onSubmit={onSubmit} saving={saving} title={title} mode={mode} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function BetForm({
  initial,
  goals,
  options,
  onSubmit,
  saving,
  title,
  mode,
  onClose,
}: {
  initial: FormState;
  goals: GoalOption[];
  options: Options | null;
  onSubmit: (payload: Record<string, unknown>) => Promise<boolean>;
  saving: boolean;
  title: string;
  mode: "create" | "edit";
  onClose: () => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));
  const rate = f.measureKind === "funnel_rate" || f.measureKind === "ai_share" || (f.measureKind === "outbound_tag" && f.submetric === "reply_rate");
  const valid = f.goalId && f.title.trim().length > 1 && f.hypothesis.trim() && f.action.trim() && f.metric.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.decisionAt);

  const idOptions: { id: string; label: string }[] =
    f.measureKind === "funnel_stage"
      ? (options?.funnelStages ?? []).map((s) => ({ id: s.id, label: s.label }))
      : f.measureKind === "funnel_rate"
        ? (options?.funnelRates ?? [])
        : f.measureKind === "ai_share"
          ? (options?.assistants ?? [])
          : f.measureKind === "outbound_tag"
            ? (options?.sequenceTags ?? []).map((t) => ({ id: t, label: t }))
            : [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="text-neutral-400">
          Hypothesis, the action that tests it, the number that proves it, and the date the verdict is due. Give it a measure so the number is read for you.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Title">
            <Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="H1.1 · Follow up with people who replied but did not book" className={inputCls} />
          </Field>
        </div>
        <Field label="Goal it serves">
          <Select value={f.goalId} onValueChange={(v) => set({ goalId: v })}>
            <SelectTrigger className={selectCls}>
              <SelectValue placeholder="Pick a goal" />
            </SelectTrigger>
            <SelectContent className={menuCls}>
              {goals.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.title} · {g.periodStart} to {g.periodEnd}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Lever" hint="Groups bets on the page. Reuse a name to keep them together.">
          <Input value={f.lever} onChange={(e) => set({ lever: e.target.value })} list="bet-levers" placeholder="Outbound messages" className={inputCls} />
          <datalist id="bet-levers">{(options?.levers ?? []).map((l) => <option key={l} value={l} />)}</datalist>
        </Field>
        <Field label="Owner">
          <Input value={f.ownerEmail} onChange={(e) => set({ ownerEmail: e.target.value })} list="bet-owners" placeholder="name@kodus.io" className={inputCls} />
          <datalist id="bet-owners">{(options?.owners ?? []).map((o) => <option key={o} value={o} />)}</datalist>
        </Field>
        <Field label="Decision date">
          <Input type="date" value={f.decisionAt} onChange={(e) => set({ decisionAt: e.target.value })} className={inputCls} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Hypothesis">
            <Textarea value={f.hypothesis} onChange={(e) => set({ hypothesis: e.target.value })} rows={2} placeholder="If we do X, number Y moves because…" className="border-white/10 bg-neutral-900 text-sm" />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Action">
            <Textarea value={f.action} onChange={(e) => set({ action: e.target.value })} rows={2} placeholder="Exactly what will be done, by whom" className="border-white/10 bg-neutral-900 text-sm" />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Metric that proves it (in words)">
            <Input value={f.metric} onChange={(e) => set({ metric: e.target.value })} placeholder="Reply → meeting on the 16 recovered threads ≥ 25%" className={inputCls} />
          </Field>
        </div>

        <div className="md:col-span-2 rounded-lg border border-white/[0.08] p-3">
          <p className="mb-3 text-[11px] uppercase tracking-wider text-neutral-500">Measure (read automatically)</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Kind">
              <Select value={f.measureKind} onValueChange={(v) => set({ measureKind: v as FormState["measureKind"], measureId: "" })}>
                <SelectTrigger className={selectCls}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={menuCls}>
                  <SelectItem value="none">None (verdict by hand)</SelectItem>
                  {(Object.keys(KIND_LABEL) as MeasureKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {f.measureKind === "manual" ? (
              <Field label="Label">
                <Input value={f.measureId} onChange={(e) => set({ measureId: e.target.value })} placeholder="Conversations recovered" className={inputCls} />
              </Field>
            ) : f.measureKind !== "none" ? (
              <Field label={f.measureKind === "outbound_tag" ? "Sequence tag" : "Which one"}>
                <Select value={f.measureId} onValueChange={(v) => set({ measureId: v })}>
                  <SelectTrigger className={selectCls}>
                    <SelectValue placeholder={idOptions.length ? "Pick" : "Nothing available"} />
                  </SelectTrigger>
                  <SelectContent className={menuCls}>
                    {idOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {f.measureKind === "outbound_tag" ? (
              <Field label="Number">
                <Select value={f.submetric} onValueChange={(v) => set({ submetric: v as FormState["submetric"] })}>
                  <SelectTrigger className={selectCls}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={menuCls}>
                    <SelectItem value="contacts">People enrolled</SelectItem>
                    <SelectItem value="replies">Replies</SelectItem>
                    <SelectItem value="reply_rate">Reply rate</SelectItem>
                    <SelectItem value="meetings">Meetings</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {f.measureKind !== "none" ? (
              <>
                <div className="grid grid-cols-[80px_1fr] gap-2">
                  <Field label="Compare">
                    <Select value={f.comparator} onValueChange={(v) => set({ comparator: v as FormState["comparator"] })}>
                      <SelectTrigger className={selectCls}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={menuCls}>
                        <SelectItem value=">=">≥</SelectItem>
                        <SelectItem value="<=">≤</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={rate ? "Threshold (%)" : "Threshold"}>
                    <Input type="number" step="any" value={f.threshold} onChange={(e) => set({ threshold: e.target.value })} placeholder={rate ? "25" : "5"} className={cn(inputCls, "tabular-nums")} />
                  </Field>
                </div>
                {f.measureKind === "manual" ? (
                  <Field label="Current value">
                    <Input type="number" step="any" value={f.currentValue} onChange={(e) => set({ currentValue: e.target.value })} className={cn(inputCls, "tabular-nums")} />
                  </Field>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Window start" hint="Default: creation date">
                      <Input type="date" value={f.windowStart} onChange={(e) => set({ windowStart: e.target.value })} className={inputCls} />
                    </Field>
                    <Field label="Window end" hint="Default: decision date">
                      <Input type="date" value={f.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} className={inputCls} />
                    </Field>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>

        <Field label="Kanban card (the action)" hint="Its stage tells whether the action was executed.">
          <Select value={f.kanbanItemId || "none"} onValueChange={(v) => set({ kanbanItemId: v === "none" ? "" : v })}>
            <SelectTrigger className={selectCls}>
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent className={menuCls}>
              <SelectItem value="none">None</SelectItem>
              {(options?.workItems ?? []).map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.title}
                  {w.stage ? ` · ${w.stage}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {mode === "create" ? (
          <Field label="Status">
            <Select value={f.status} onValueChange={(v) => set({ status: v as BetStatus })}>
              <SelectTrigger className={selectCls}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={menuCls}>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field label="Status" hint="Use the decide buttons on the page to change it.">
            <div className="flex h-9 items-center text-sm text-neutral-300">{STATUS_LABEL[f.status].label}</div>
          </Field>
        )}
        <div className="md:col-span-2">
          <Field label="Notes">
            <Textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} className="border-white/10 bg-neutral-900 text-sm" />
          </Field>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200">
          Cancel
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await onSubmit(toPayload(f, mode))) onClose();
          }}
          disabled={!valid || saving}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BetsPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const params = useSearchParams();
  const goalFilter = params.get("goal");
  const [token, setToken] = useState<string | null>(null);
  const [bets, setBets] = useState<BetRow[]>([]);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [options, setOptions] = useState<Options | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "decided">("open");
  const [lever, setLever] = useState<string>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" | "edit"; bet?: BetRow } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: s }) => setToken(s.session?.access_token ?? null));
  }, [supabase]);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" }), [token]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/bets", { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load");
      setBets(json.bets as BetRow[]);
      setGoals(json.goals as GoalOption[]);
      setOptions(json.options as Options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load";
      setError(/public\.bets|column .* does not exist|schema cache/.test(msg) ? "The bets tables are behind: run the bets migrations." : msg);
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const call = async (url: string, init: RequestInit): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url, { ...init, headers });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const decide = async (bet: BetRow, status: BetStatus) => {
    let verdict = bet.verdict ?? "";
    if (status === "won" || status === "lost") {
      const suggested = bet.evaluation?.suggestedVerdict ?? "";
      const v = window.prompt("One-line verdict (what the number showed):", verdict || suggested);
      if (v == null) return;
      verdict = v;
    }
    await call(`/api/bets/${bet.id}`, { method: "PATCH", body: JSON.stringify({ status, verdict }) });
  };

  const markActionDone = async (bet: BetRow, done: boolean) => {
    await call(`/api/bets/${bet.id}`, { method: "PATCH", body: JSON.stringify({ actionDoneAt: done ? new Date().toISOString() : null }) });
  };

  const remove = async (bet: BetRow) => {
    if (!window.confirm("Delete this bet? Prefer deciding it (lost / became operation) so the verdict stays on record.")) return;
    await call(`/api/bets/${bet.id}`, { method: "DELETE" });
  };

  const visible = bets
    .filter((b) => (tab === "open" ? b.status === "active" || b.status === "queued" : b.status !== "active" && b.status !== "queued"))
    .filter((b) => (lever === "all" ? true : lever === "none" ? !b.lever : b.lever === lever))
    .filter((b) => (goalFilter ? b.goalId === goalFilter : true));
  const groups = useMemo(() => {
    const m = new Map<string, BetRow[]>();
    for (const b of visible) {
      const k = b.lever ?? "";
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])));
  }, [visible]);

  const today = new Date().toISOString().slice(0, 10);
  const active = bets.filter((b) => b.status === "active");
  const pastDue = active.filter((b) => b.decisionAt < today);
  const metCount = active.filter((b) => b.evaluation?.met === true).length;
  const unmeasured = active.filter((b) => !b.measure).length;
  const goalName = goalFilter ? goals.find((g) => g.id === goalFilter)?.title ?? bets.find((b) => b.goalId === goalFilter)?.goalTitle ?? null : null;

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-6 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-neutral-100">
            <FlaskConical className="size-5 text-violet-400" /> Bets
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            What we run to move a goal: a hypothesis, the action that tests it, the number that proves it, and the date the verdict is due. Tasks live on the Kanban; this is where they get judged.
          </p>
          {goalName ? (
            <p className="mt-1 text-xs text-neutral-500">
              Showing bets on <span className="text-neutral-300">{goalName}</span> ·{" "}
              <a href="/bets" className="text-violet-300 hover:underline">
                show all
              </a>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-white/[0.08] p-0.5 text-xs">
            {(["open", "decided"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={cn("rounded px-2.5 py-1", tab === t ? "bg-white/[0.08] text-neutral-100" : "text-neutral-400 hover:text-neutral-200")}>
                {t === "open" ? "Open" : "Decided"}
              </button>
            ))}
          </div>
          <Select value={lever} onValueChange={setLever}>
            <SelectTrigger className="h-8 w-[180px] border-white/[0.08] bg-transparent text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={menuCls}>
              <SelectItem value="all">All levers</SelectItem>
              {(options?.levers ?? []).map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
              <SelectItem value="none">No lever</SelectItem>
            </SelectContent>
          </Select>
          <button type="button" onClick={() => load()} title="Reload" aria-label="Reload" className="inline-flex size-8 items-center justify-center rounded-md border border-white/[0.08] text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => setDialog({ mode: "create" })}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
          >
            <Plus className="size-3.5" /> New bet
          </button>
        </div>
      </div>

      {error ? <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p> : null}

      {/* Reading */}
      {!loading || bets.length ? (
        <section>
          <SectionHeader label="Reading" hint="Active bets, and what the numbers say today." />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Active", value: active.length, note: `${bets.filter((b) => b.status === "queued").length} queued` },
              { label: "Threshold met", value: metCount, note: "of active bets with a measure", tone: metCount ? "text-emerald-300" : "" },
              { label: "Past decision date", value: pastDue.length, note: "need a verdict", tone: pastDue.length ? "text-amber-300" : "" },
              { label: "Without a measure", value: unmeasured, note: "cannot be read automatically", tone: unmeasured ? "text-amber-300" : "" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-white/[0.06] bg-neutral-900/40 p-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">{c.label}</p>
                <p className={cn("mt-1 text-3xl font-semibold tabular-nums tracking-tight text-neutral-100", c.tone)}>{c.value}</p>
                <p className="text-[11px] text-neutral-500">{c.note}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {loading && bets.length === 0 ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="size-6 animate-spin text-neutral-600" />
        </div>
      ) : null}

      {/* Groups by lever */}
      {groups.map(([lv, list]) => (
        <section key={lv || "none"}>
          <SectionHeader label={lv || "No lever"} hint={`${list.length} bet${list.length === 1 ? "" : "s"}`} />
          <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06] bg-neutral-900/40">
            {list.map((b) => {
              const isOpen = open === b.id;
              const dl = daysLabel(b.evaluation?.daysLeft ?? 0, b.decisionAt, b.status);
              return (
                <article key={b.id} className={cn("group", isOpen && "bg-white/[0.02]")}>
                  <div className="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,3fr)]">
                    <div className="min-w-0">
                      <button type="button" onClick={() => setOpen(isOpen ? null : b.id)} className="flex w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60">
                        {isOpen ? <ChevronDown className="mt-1 size-3.5 shrink-0 text-neutral-500" /> : <ChevronRight className="mt-1 size-3.5 shrink-0 text-neutral-500" />}
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={cn("rounded px-1.5 py-0.5 text-[11px]", STATUS_LABEL[b.status].className)}>{STATUS_LABEL[b.status].label}</span>
                            <span className="font-medium text-neutral-100">{b.title}</span>
                          </span>
                          <span className="mt-1 line-clamp-2 block text-sm text-neutral-400">{b.hypothesis}</span>
                          <span className="mt-1 block text-[11px] text-neutral-500">
                            {b.goalTitle ? <>goal: {b.goalTitle}</> : null}
                            {b.ownerEmail ? <> · {b.ownerEmail.split("@")[0]}</> : null}
                            {b.entries.length ? <> · {b.entries.length} journal entr{b.entries.length === 1 ? "y" : "ies"}</> : null}
                          </span>
                        </span>
                      </button>
                    </div>
                    <MeasureBlock bet={b} />
                    <div className="flex flex-col items-start gap-2 lg:items-end">
                      <span className={cn("text-xs tabular-nums", dl.tone)}>{dl.text}</span>
                      <Levels ev={b.evaluation} compact />
                      <div className="flex flex-wrap gap-1 opacity-70 transition-opacity group-hover:opacity-100 lg:justify-end">
                        {b.status === "queued" ? (
                          <button type="button" onClick={() => decide(b, "active")} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">
                            activate
                          </button>
                        ) : b.status === "active" ? (
                          <>
                            <button type="button" onClick={() => decide(b, "won")} className="rounded border border-sky-500/30 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-500/10">
                              won
                            </button>
                            <button type="button" onClick={() => decide(b, "lost")} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">
                              lost
                            </button>
                            <button type="button" onClick={() => decide(b, "operation")} className="rounded border border-violet-500/30 px-2 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/10">
                              became operation
                            </button>
                          </>
                        ) : (
                          <button type="button" onClick={() => decide(b, "active")} className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-white/5">
                            reopen
                          </button>
                        )}
                        <button type="button" onClick={() => setDialog({ mode: "edit", bet: b })} title="Edit" aria-label="Edit" className="rounded border border-transparent p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-200">
                          <Pencil className="size-3.5" />
                        </button>
                        <button type="button" onClick={() => remove(b)} title="Delete" aria-label="Delete" className="rounded border border-transparent p-1 text-neutral-600 hover:bg-red-500/10 hover:text-red-300">
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {isOpen ? (
                    <div className="grid gap-4 border-t border-white/[0.06] bg-black/20 px-4 py-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                      <div className="space-y-3 text-sm">
                        <div>
                          <p className="text-[11px] uppercase tracking-wider text-neutral-500">Action</p>
                          <p className="text-neutral-300">{b.action}</p>
                          <div className="mt-1 flex items-center gap-2 text-[11px]">
                            {b.actionDoneAt ? (
                              <>
                                <span className="inline-flex items-center gap-1 text-emerald-300">
                                  <CheckCircle2 className="size-3" /> done {b.actionDoneAt.slice(0, 10)}
                                </span>
                                <button type="button" onClick={() => markActionDone(b, false)} className="text-neutral-500 hover:text-neutral-300">
                                  undo
                                </button>
                              </>
                            ) : (
                              <button type="button" onClick={() => markActionDone(b, true)} className="inline-flex items-center gap-1 text-neutral-400 hover:text-neutral-200">
                                <CircleDashed className="size-3" /> mark action as executed
                              </button>
                            )}
                            {b.kanbanItemId ? (
                              <a href={`/kanban`} className="text-neutral-500 hover:text-neutral-300">
                                Kanban card
                              </a>
                            ) : null}
                          </div>
                        </div>
                        <div>
                          <p className="text-[11px] uppercase tracking-wider text-neutral-500">Metric that proves it</p>
                          <p className="text-neutral-300">{b.metric}</p>
                        </div>
                        {b.verdict ? (
                          <div>
                            <p className="text-[11px] uppercase tracking-wider text-neutral-500">Verdict</p>
                            <p className="text-neutral-200">{b.verdict}</p>
                          </div>
                        ) : null}
                        {b.notes ? (
                          <div>
                            <p className="text-[11px] uppercase tracking-wider text-neutral-500">Notes</p>
                            <p className="whitespace-pre-wrap text-neutral-400">{b.notes}</p>
                          </div>
                        ) : null}
                        <Journal bet={b} headers={headers} onChanged={load} />
                      </div>
                      <div className="space-y-3">
                        <p className="text-[11px] uppercase tracking-wider text-neutral-500">Follow-up</p>
                        {b.evaluation ? (
                          <ol className="space-y-2 text-sm">
                            {[b.evaluation.levels.action, b.evaluation.levels.metric, b.evaluation.levels.opportunities].map((lv) => (
                              <li key={lv.label} className="flex items-start gap-2">
                                <span className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", LEVEL_STYLE[lv.status].dot)} />
                                <span>
                                  <span className={cn("font-medium", LEVEL_STYLE[lv.status].text)}>{lv.label}</span>
                                  <span className="block text-xs text-neutral-400">{lv.detail}</span>
                                </span>
                              </li>
                            ))}
                          </ol>
                        ) : null}
                        {b.evaluation ? (
                          <div className="rounded-md border border-white/[0.06] bg-neutral-950/60 p-3 text-sm">
                            <p className="text-[11px] uppercase tracking-wider text-neutral-500">What the evidence says</p>
                            <p className="mt-1 text-neutral-200">{b.evaluation.suggestedVerdict}</p>
                            <p className="mt-2 text-[11px] text-neutral-500">
                              Window {b.evaluation.window.start} to {b.evaluation.window.effectiveEnd}
                              {b.evaluation.previousWindow ? `, compared with ${b.evaluation.previousWindow.start} to ${b.evaluation.previousWindow.end}` : ""}. An agent reads the same thing with evaluateBet.
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {!loading && groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/10 px-6 py-12 text-center text-sm text-neutral-500">
          {tab === "open" ? "No open bets. Write the hypothesis the way you would defend it in a review." : "Nothing decided yet."}
        </div>
      ) : null}

      <BetDialog
        open={dialog != null}
        onOpenChange={(v) => !v && setDialog(null)}
        initial={dialog?.mode === "edit" && dialog.bet ? fromBet(dialog.bet) : { ...EMPTY, goalId: goalFilter ?? goals[0]?.id ?? "" }}
        goals={goals}
        options={options}
        saving={saving}
        title={dialog?.mode === "edit" ? "Edit bet" : "New bet"}
        mode={dialog?.mode === "edit" ? "edit" : "create"}
        onSubmit={async (payload) => {
          if (dialog?.mode === "edit" && dialog.bet) return call(`/api/bets/${dialog.bet.id}`, { method: "PATCH", body: JSON.stringify(payload) });
          return call("/api/bets", { method: "POST", body: JSON.stringify(payload) });
        }}
      />
    </div>
  );
}
