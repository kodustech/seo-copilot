"use client";

/* Hallmark · genre: modern-minimal · macrostructure: Workbench (app page: reading → matrix → targets) · theme: app tokens (dark neutral, violet ≤ 5%) · enrichment: none · nav: app shell · footer: none */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Link2, Loader2, Pause, Play, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";

import {
  AI_ENGINES,
  DEFAULT_MODELS,
  DEFAULT_SAMPLES,
  ENGINE_LABEL,
  MAX_SAMPLES,
  WEEKDAY_LABELS,
  type AiEngine,
  type AiPromptRun,
  type AiVisibilitySettings,
  type EngineConfig,
  type PromptEngineResult,
  type RunSummary,
  type VisibilitySummary,
} from "@/lib/ai-visibility";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/markdown-content";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const LANGS = [
  { value: "en", label: "EN" },
  { value: "pt", label: "PT" },
];

const SHORT_LABEL: Record<AiEngine, string> = {
  perplexity: "Perplexity",
  chat_gpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  google_ai: "Google AIO",
};

function pct(n: number | null | undefined): string {
  return n == null ? "–" : `${Math.round(n * 100)}%`;
}

function usd(n: number | null | undefined): string {
  return n == null ? "–" : `US$ ${n.toFixed(2)}`;
}

/** Citation markers like [1][4][12] that the models append; noise on screen. */
function stripCitationMarks(text: string): string {
  return text.replace(/(\[\d{1,2}\])+/g, "").replace(/[ \t]+\n/g, "\n");
}

// ---------------------------------------------------------------------------
// Small pieces
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

function IconButton({
  label,
  onClick,
  disabled,
  children,
  className,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md border border-white/[0.08] text-neutral-400 transition-colors hover:bg-white/[0.05] hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A thin bar: the share of samples naming the brand. */
function ShareBar({ value, className }: { value: number | null; className?: string }) {
  // Zero stays empty; only a tiny positive share gets the 2% floor so it is
  // visible at all.
  const w = value == null || value <= 0 ? 0 : Math.max(2, Math.round(value * 100));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]", className)} aria-hidden="true">
      {w > 0 ? <div className="h-full rounded-full bg-emerald-400/80" style={{ width: `${w}%` }} /> : null}
    </div>
  );
}

type CellState = "all" | "some" | "none" | "error" | "empty";

function cellState(r: PromptEngineResult | undefined): CellState {
  if (!r) return "empty";
  if (r.samples === 0) return "error";
  const rate = r.rate ?? 0;
  if (rate >= 1) return "all";
  if (rate > 0) return "some";
  return "none";
}

const SWATCH: Record<CellState, string> = {
  all: "bg-emerald-400",
  some: "bg-amber-400",
  none: "bg-transparent ring-1 ring-inset ring-white/20",
  error: "bg-transparent ring-1 ring-inset ring-amber-400/70",
  empty: "bg-transparent ring-1 ring-inset ring-white/10",
};

/**
 * One prompt on one assistant, in one line: swatch, how many samples named
 * the brand (or its list position when there is one sample), then the two
 * facts that matter next: the position and whether a page of ours was cited.
 */
function MatrixCell({ result, active, onOpen }: { result: PromptEngineResult | undefined; active: boolean; onOpen: () => void }) {
  const state = cellState(result);
  let main = "–";
  let aside: string | null = null;
  if (result && state !== "empty") {
    if (state === "error") main = "error";
    else if (result.samples > 1) {
      main = `${result.mentioned}/${result.samples}`;
      if (result.avgPosition != null) aside = `#${result.avgPosition}`;
    } else if (result.mentioned) {
      main = result.avgPosition != null ? `#${result.avgPosition}` : "named";
      if (result.avgPosition != null && result.listSize != null) aside = `of ${result.listSize}`;
    } else {
      main = "no";
    }
    if (result.engine === "google_ai") {
      const serp = result.extra.aiOverview === false ? "no overview" : result.extra.organicRank != null ? `org #${result.extra.organicRank}` : null;
      if (serp) aside = aside ? `${aside} · ${serp}` : serp;
    }
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={result?.error ?? undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs tabular-nums transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
        active && "bg-white/[0.06]",
      )}
    >
      <span className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", SWATCH[state])} />
      <span className={cn("whitespace-nowrap", state === "all" || state === "some" ? "text-neutral-100" : state === "error" ? "text-amber-300" : "text-neutral-500")}>{main}</span>
      {aside ? <span className="whitespace-nowrap text-neutral-500">{aside}</span> : null}
      {result?.brandCited ? <Link2 className="ml-auto size-3 shrink-0 text-neutral-600" aria-label="Cited one of our pages" /> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Answer panel (one sample)
// ---------------------------------------------------------------------------

function SamplePanel({ run, total }: { run: AiPromptRun; total: number }) {
  const [showAll, setShowAll] = useState(false);
  const text = stripCitationMarks(run.answer ?? "");
  const long = text.length > 1400;
  return (
    <article className="rounded-lg border border-white/[0.06] bg-neutral-950/60">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] px-4 py-2 text-xs text-neutral-400">
        {total > 1 ? <span className="font-medium text-neutral-200">Sample {run.sample} of {total}</span> : <span className="font-medium text-neutral-200">Answer</span>}
        <span>{run.modelName ?? "model?"}</span>
        {run.mentioned ? (
          <span className="text-emerald-300">Kodus {run.position != null ? `#${run.position}${run.listSize != null ? ` of ${run.listSize}` : ""}` : "named"}</span>
        ) : (
          <span className="text-neutral-500">Kodus absent</span>
        )}
        {run.engine === "google_ai" ? (
          <span>
            {run.extra.aiOverview ? "AI Overview present" : "no AI Overview"}
            {run.extra.organicRank != null ? ` · organic #${run.extra.organicRank}` : " · outside the organic top 10"}
          </span>
        ) : null}
        {run.costUsd != null ? <span className="ml-auto text-neutral-600">{usd(run.costUsd)}</span> : null}
      </header>
      {run.error ? <p className="px-4 py-3 text-xs text-amber-300">{run.error}</p> : null}
      {text ? (
        <div className="px-4 py-3">
          <MarkdownContent text={showAll || !long ? text : `${text.slice(0, 1400)}…`} className="text-[13px] text-neutral-300" />
          {long ? (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-xs text-neutral-400 hover:text-neutral-200">
              {showAll ? "show less" : "show all"}
            </button>
          ) : null}
        </div>
      ) : null}
      {run.citations.length || run.competitors.length || run.fanOutQueries.length ? (
        <footer className="grid gap-4 border-t border-white/[0.06] px-4 py-3 text-xs md:grid-cols-2">
          {run.citations.length ? (
            <div className="min-w-0">
              <p className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">Sources cited</p>
              <ol className="space-y-0.5">
                {run.citations.slice(0, 12).map((c) => {
                  const host = c.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
                  return (
                    <li key={c.url} className="flex min-w-0 items-baseline gap-2">
                      <a href={c.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-neutral-200 hover:underline">
                        {c.title || c.url}
                      </a>
                      <span className="shrink-0 text-neutral-600">{host}</span>
                    </li>
                  );
                })}
                {run.citations.length > 12 ? <li className="text-neutral-600">+{run.citations.length - 12}</li> : null}
              </ol>
            </div>
          ) : null}
          <div className="min-w-0 space-y-2">
            {run.competitors.length ? (
              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">Competitors named</p>
                <p className="text-neutral-300">{run.competitors.join(", ")}</p>
              </div>
            ) : null}
            {run.fanOutQueries.length ? (
              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">{run.engine === "google_ai" ? "Related searches" : "The model searched for"}</p>
                <p className="text-neutral-400">{run.fanOutQueries.map((q) => `“${q}”`).join(", ")}</p>
              </div>
            ) : null}
            {run.engine === "google_ai" && run.extra.organicTop?.length ? (
              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">Organic top 10</p>
                <p className="text-neutral-400">{run.extra.organicTop.join(", ")}</p>
              </div>
            ) : null}
          </div>
        </footer>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: AiVisibilitySettings;
  onSave: (patch: { weekday: number; engines: EngineConfig[] }) => Promise<boolean>;
  saving: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl border-white/10 bg-neutral-950 text-neutral-100">
        {/* Keyed on open + settings so the form starts from the saved values every time it opens. */}
        <SettingsForm key={`${open}:${settings.updatedAt}`} settings={settings} onSave={onSave} saving={saving} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({
  settings,
  onSave,
  saving,
  onClose,
}: {
  settings: AiVisibilitySettings;
  onSave: (patch: { weekday: number; engines: EngineConfig[] }) => Promise<boolean>;
  saving: boolean;
  onClose: () => void;
}) {
  const [weekday, setWeekday] = useState(settings.weekday);
  const [engines, setEngines] = useState<EngineConfig[]>(settings.engines);

  const cfgOf = (engine: AiEngine) => engines.find((e) => e.engine === engine);
  const toggle = (engine: AiEngine, on: boolean) => {
    setEngines((list) =>
      on
        ? list.some((e) => e.engine === engine)
          ? list
          : [...list, { engine, model: DEFAULT_MODELS[engine], samples: DEFAULT_SAMPLES[engine] }]
        : list.filter((e) => e.engine !== engine),
    );
  };
  const patch = (engine: AiEngine, p: Partial<EngineConfig>) => setEngines((list) => list.map((e) => (e.engine === engine ? { ...e, ...p } : e)));
  const dirty = weekday !== settings.weekday || JSON.stringify(engines) !== JSON.stringify(settings.engines);

  return (
    <>
        <DialogHeader>
          <DialogTitle>Weekly run</DialogTitle>
          <DialogDescription className="text-neutral-400">
            When to ask, which assistants, and how many times per prompt. Changes apply to the next run, no deploy needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid grid-cols-[120px_1fr] items-center gap-3">
            <label className="text-sm text-neutral-300">Day of week</label>
            <div className="flex items-center gap-3">
              <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                <SelectTrigger className="h-9 w-40 border-white/10 bg-neutral-900 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                  {WEEKDAY_LABELS.map((label, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-neutral-500">07:00 UTC · last run: {settings.lastRunOn ?? "never"}</span>
            </div>
          </div>

          <div>
            <div className="mb-2 grid grid-cols-[1fr_170px_88px] items-end gap-3 text-[11px] uppercase tracking-wider text-neutral-500">
              <span>Assistant</span>
              <span>Model</span>
              <span>Samples</span>
            </div>
            <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08]">
              {AI_ENGINES.map((engine) => {
                const cfg = cfgOf(engine);
                const on = Boolean(cfg);
                return (
                  <div key={engine} className={cn("grid grid-cols-[1fr_170px_88px] items-center gap-3 px-3 py-2", !on && "opacity-60")}>
                    <label className="flex items-center gap-3 text-sm text-neutral-200">
                      <Switch checked={on} onCheckedChange={(v) => toggle(engine, v)} aria-label={ENGINE_LABEL[engine]} />
                      {ENGINE_LABEL[engine]}
                    </label>
                    {engine === "google_ai" ? (
                      <span className="text-xs text-neutral-500">SERP with AI Overview</span>
                    ) : (
                      <Input
                        value={cfg?.model ?? DEFAULT_MODELS[engine]}
                        disabled={!on}
                        onChange={(e) => patch(engine, { model: e.target.value })}
                        className="h-8 border-white/10 bg-neutral-900 text-xs"
                      />
                    )}
                    <Input
                      type="number"
                      min={1}
                      max={MAX_SAMPLES}
                      value={cfg?.samples ?? DEFAULT_SAMPLES[engine]}
                      disabled={!on}
                      onChange={(e) => patch(engine, { samples: Math.max(1, Math.min(MAX_SAMPLES, Number(e.target.value) || 1)) })}
                      className="h-8 border-white/10 bg-neutral-900 text-xs tabular-nums"
                    />
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Answers vary between runs; more samples make the rate steadier. Measured cost per question: Perplexity sonar US$ 0.006 · ChatGPT gpt-5.5 US$ 0.09 · Google AI Overview US$ 0.003 · Gemini and Claude cost about the same as ChatGPT.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200">
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              if (await onSave({ weekday, engines })) onClose();
            }}
            disabled={!dirty || saving || engines.length === 0}
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

export function AiVisibilityPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [summary, setSummary] = useState<VisibilitySummary | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [runOn, setRunOn] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | "all" | null>(null);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [open, setOpen] = useState<{ promptId: string; engine: AiEngine } | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ prompt: "", language: "en", tags: "" });
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [allSearches, setAllSearches] = useState(false);

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
      const res = await fetch(`/api/ai-visibility/summary${runOn ? `?runOn=${runOn}` : ""}`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load");
      setSummary(json.summary as VisibilitySummary);
      setDates(json.dates as string[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load";
      setError(
        /ai_prompts|ai_visibility_settings|ai_prompt_runs|ai_prompt_run_dates/.test(msg) && /schema cache|does not exist/.test(msg)
          ? "The AI visibility tables do not exist in this environment yet. Run the ai_visibility migrations."
          : msg,
      );
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [token, headers, runOn]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async (patch: { weekday: number; engines: EngineConfig[] }): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-visibility/settings", { method: "PATCH", headers, body: JSON.stringify(patch) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Falhou");
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falhou");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (promptIds?: string[]) => {
    setRunning(promptIds?.[0] ?? "all");
    setError(null);
    setLastRun(null);
    try {
      const res = await fetch("/api/ai-visibility/run", { method: "POST", headers, body: JSON.stringify({ promptIds, force: Boolean(promptIds) }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Falhou");
      setLastRun(json.summary as RunSummary);
      setRunOn(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falhou");
    } finally {
      setRunning(null);
    }
  };

  const addPrompt = async () => {
    setSaveInFlight(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-visibility/prompts", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: form.prompt, language: form.language, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Falhou");
      setForm({ prompt: "", language: form.language, tags: "" });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falhou");
    } finally {
      setSaveInFlight(false);
    }
  };

  const patchPrompt = async (id: string, patch: Record<string, unknown>) => {
    const res = await fetch(`/api/ai-visibility/prompts/${id}`, { method: "PATCH", headers, body: JSON.stringify(patch) });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Falhou");
      return;
    }
    await load();
  };

  const removePrompt = async (id: string) => {
    if (!window.confirm("Delete this prompt and its history?")) return;
    const res = await fetch(`/api/ai-visibility/prompts/${id}`, { method: "DELETE", headers });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Falhou");
      return;
    }
    await load();
  };

  const engines = summary?.settings.engines.map((e) => e.engine) ?? [];
  const activeCount = summary?.prompts.filter((p) => p.prompt.active).length ?? 0;
  const engineCount = summary?.engines.length ?? 0;
  const configLabel = summary ? `${WEEKDAY_LABELS[summary.settings.weekday]} · ${engines.length} assistant${engines.length === 1 ? "" : "s"}` : "";
  const totalSamples = summary?.engines.reduce((s, e) => s + e.samples, 0) ?? 0;
  const totalMentioned = summary?.engines.reduce((s, e) => s + e.mentioned, 0) ?? 0;
  const rollingAll = (() => {
    if (!summary) return null;
    const withRolling = summary.engines.filter((e) => e.rollingShare != null && e.rollingRuns > 1);
    if (!withRolling.length) return null;
    return { runs: Math.max(...withRolling.map((e) => e.rollingRuns)), share: withRolling.reduce((s, e) => s + (e.rollingShare ?? 0), 0) / withRolling.length };
  })();
  const absentSources = summary?.domains.filter((d) => d.runsWithoutBrand > 0) ?? [];
  const maxAbsent = absentSources[0]?.runsWithoutBrand ?? 1;
  const maxComp = summary?.competitors[0]?.runs ?? 1;
  const searches = summary?.searches ?? [];
  const shownSearches = allSearches ? searches : searches.slice(0, 10);
  const openResult = open ? summary?.prompts.find((p) => p.prompt.id === open.promptId)?.runs[open.engine] : undefined;

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-6 px-6 py-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-neutral-100">
            <Bot className="size-5 text-violet-400" /> AI visibility
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            Every week, buyer prompts go to the assistants with web search on. The reading: where Kodus shows up, in which position, and which pages the model uses as sources.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dates.length > 1 ? (
            <Select value={runOn ?? dates[0]} onValueChange={(v) => setRunOn(v === dates[0] ? null : v)}>
              <SelectTrigger className="h-8 w-[140px] border-white/[0.08] bg-transparent text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                {dates.map((d) => (
                  <SelectItem key={d} value={d}>
                    Run {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-white/[0.08] px-2.5 text-xs text-neutral-300 hover:bg-white/[0.05] hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
            title="Configure the weekly run"
          >
            <Settings2 className="size-3.5 text-neutral-500" />
            {configLabel || "Configure"}
          </button>
          <IconButton label="Reload" onClick={() => load()}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </IconButton>
          <button
            type="button"
            onClick={() => runNow()}
            disabled={running != null || activeCount === 0}
            title="Ask now whatever has not been asked today"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-40"
          >
            {running === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Run now
          </button>
        </div>
      </div>

      {error ? <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p> : null}
      {lastRun ? (
        <p className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
          Done: {lastRun.asked} questions, Kodus named in {lastRun.mentioned}. {lastRun.skipped} already asked today, {lastRun.failed} failed, {usd(lastRun.costUsd)}.
          {lastRun.errors.length ? ` Errors: ${lastRun.errors.slice(0, 2).join(" | ")}` : ""}
        </p>
      ) : null}

      {loading && !summary ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="size-6 animate-spin text-neutral-600" />
        </div>
      ) : null}

      {/* Reading of the run */}
      {summary && engineCount > 0 ? (
        <section>
          <SectionHeader label={`Reading of run ${summary.runOn}`} hint={`${usd(summary.totalCostUsd)} this run`} />
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40 p-5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">Kodus named</p>
              <p className="mt-2 text-5xl font-semibold tabular-nums tracking-tight text-neutral-100">{pct(summary.overallShare)}</p>
              <p className="mt-2 text-sm text-neutral-400">
                {totalMentioned} of {totalSamples} answers, {activeCount} prompts, {engineCount} assistant{engineCount === 1 ? "" : "s"}.
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {rollingAll ? `Average of the last ${rollingAll.runs} runs: ${pct(rollingAll.share)}.` : "First run; the rolling average appears from the second one."}
              </p>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-neutral-500">
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-4 py-2 text-left font-medium">Assistant</th>
                    <th className="px-3 py-2 text-left font-medium">Named</th>
                    <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Prompts</th>
                    <th className="px-3 py-2 text-right font-medium">Position</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Our page cited</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {summary.engines.map((e) => (
                    <tr key={e.engine}>
                      <td className="px-4 py-2.5">
                        <p className="text-neutral-100">{e.label}</p>
                        <p className="text-[11px] text-neutral-500">
                          {e.model}
                          {e.failed ? ` · ${e.failed} failed` : ""}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <ShareBar value={e.share} className="w-24 md:w-32" />
                          <span className="w-12 text-right tabular-nums text-neutral-100">{pct(e.share)}</span>
                          <span className="hidden text-xs tabular-nums text-neutral-500 lg:inline">
                            {e.mentioned}/{e.samples}
                            {e.rollingRuns > 1 && e.rollingShare != null ? ` · ${pct(e.rollingShare)} over ${e.rollingRuns}` : ""}
                          </span>
                        </div>
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums text-neutral-300 md:table-cell">
                        {e.promptsMentioned}/{e.prompts}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">{e.avgPosition != null ? `#${e.avgPosition}` : "–"}</td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums text-neutral-300 sm:table-cell">{e.brandCited ? `${e.brandCited}×` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* Prompt × assistant matrix */}
      {summary ? (
        <section>
          <SectionHeader
            label={`Prompts · ${activeCount} active`}
            hint="Each cell: how many samples named Kodus, and the average list position. Click to read the answer."
            right={
              <span className="flex items-center gap-3 text-[11px] text-neutral-500">
                <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-[3px] bg-emerald-400" /> all</span>
                <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-[3px] bg-amber-400" /> some</span>
                <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-[3px] ring-1 ring-inset ring-white/20" /> none</span>
                <span className="inline-flex items-center gap-1.5"><Link2 className="size-3" /> our page cited</span>
              </span>
            }
          />
          <div className="overflow-x-auto rounded-lg border border-white/[0.06] bg-neutral-900/40">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-neutral-500">
                <tr className="border-b border-white/[0.06]">
                  <th className="px-4 py-2 text-left font-medium">Prompt</th>
                  {engines.map((e) => (
                    <th key={e} className="w-[132px] px-2 py-2 text-left font-medium">
                      {SHORT_LABEL[e]}
                    </th>
                  ))}
                  <th className="w-[84px] px-2 py-2 text-right font-medium" title="Assistants that named Kodus in this run">Present</th>
                  <th className="w-[92px] px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {summary.prompts.map(({ prompt, runs }) => {
                  const isOpen = open?.promptId === prompt.id;
                  const present = engines.filter((e) => (runs[e]?.mentioned ?? 0) > 0).length;
                  const asked = engines.filter((e) => (runs[e]?.samples ?? 0) > 0).length;
                  return (
                    <RowGroup key={prompt.id}>
                      <tr className={cn("group", !prompt.active && "opacity-50", isOpen && "bg-white/[0.02]")}>
                        <td className="max-w-[460px] px-4 py-2 align-middle">
                          <button
                            type="button"
                            onClick={() => setOpen(isOpen ? null : { promptId: prompt.id, engine: engines.find((e) => runs[e]) ?? engines[0] })}
                            className="flex w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
                          >
                            {isOpen ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-neutral-500" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-neutral-500" />}
                            <span className="min-w-0">
                              <span className="block text-neutral-100">{prompt.prompt}</span>
                              <span className="block text-[11px] text-neutral-500">
                                {prompt.language.toUpperCase()}
                                {prompt.tags.length ? ` · ${prompt.tags.join(", ")}` : ""}
                                {!prompt.active ? " · paused" : ""}
                              </span>
                            </span>
                          </button>
                        </td>
                        {engines.map((e) => (
                          <td key={e} className="px-1 py-1 align-middle">
                            <MatrixCell
                              result={runs[e]}
                              active={isOpen && open?.engine === e}
                              onOpen={() => setOpen(isOpen && open?.engine === e ? null : { promptId: prompt.id, engine: e })}
                            />
                          </td>
                        ))}
                        <td className="px-2 py-2 text-right align-middle tabular-nums">
                          <span className={cn(present === 0 ? "text-neutral-500" : present === asked ? "text-emerald-300" : "text-neutral-200")}>
                            {asked ? `${present}/${asked}` : "–"}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right align-middle">
                          <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            <IconButton label="Ask only this one now" onClick={() => runNow([prompt.id])} disabled={running != null} className="size-7 border-transparent">
                              {running === prompt.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                            </IconButton>
                            <IconButton label={prompt.active ? "Pause" : "Resume"} onClick={() => patchPrompt(prompt.id, { active: !prompt.active })} className="size-7 border-transparent">
                              {prompt.active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                            </IconButton>
                            <IconButton label="Delete" onClick={() => removePrompt(prompt.id)} className="size-7 border-transparent hover:text-red-300">
                              <Trash2 className="size-3.5" />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="bg-black/20">
                          <td colSpan={engines.length + 3} className="px-4 py-4">
                            <div className="mb-3 flex flex-wrap items-center gap-1">
                              {engines
                                .filter((e) => runs[e])
                                .map((e) => (
                                  <button
                                    key={e}
                                    type="button"
                                    onClick={() => setOpen({ promptId: prompt.id, engine: e })}
                                    className={cn(
                                      "rounded-md px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
                                      e === open?.engine ? "bg-white/[0.08] text-neutral-100" : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200",
                                    )}
                                  >
                                    {ENGINE_LABEL[e]}
                                    {runs[e] ? <span className="ml-1.5 text-neutral-500">{runs[e]!.samples > 1 ? `${runs[e]!.mentioned}/${runs[e]!.samples}` : runs[e]!.mentioned ? "named" : "no"}</span> : null}
                                  </button>
                                ))}
                            </div>
                            {openResult && openResult.runs.length ? (
                              <div className="space-y-3">
                                {openResult.runs.map((run) => (
                                  <SamplePanel key={run.id} run={run} total={openResult.runs.length} />
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-neutral-500">No answer in this run.</p>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </RowGroup>
                  );
                })}
                {summary.prompts.length === 0 ? (
                  <tr>
                    <td colSpan={engines.length + 3} className="px-4 py-8 text-center text-sm text-neutral-500">
                      No prompts yet. Write the question the way a buyer would.
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <td colSpan={engines.length + 3} className="px-2 py-1">
                    {adding ? (
                      <div className="grid gap-2 p-2 md:grid-cols-[minmax(0,1fr)_84px_200px_auto_auto]">
                        <Textarea
                          autoFocus
                          value={form.prompt}
                          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                          placeholder="The way a buyer would ask. E.g. What are the best AI code review tools for a team on GitLab that wants a self-hosted option?"
                          rows={2}
                          maxLength={500}
                          className="border-white/10 bg-neutral-950 text-sm"
                        />
                        <Select value={form.language} onValueChange={(v) => setForm({ ...form, language: v })}>
                          <SelectTrigger className="h-9 border-white/10 bg-neutral-950 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                            {LANGS.map((l) => (
                              <SelectItem key={l.value} value={l.value}>
                                {l.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="tags: gitlab, self-hosted" className="h-9 border-white/10 bg-neutral-950 text-xs" />
                        <button
                          type="button"
                          onClick={addPrompt}
                          disabled={saveInFlight || form.prompt.trim().length < 5}
                          className="h-9 rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
                        >
                          {saveInFlight ? "Saving…" : "Add"}
                        </button>
                        <button type="button" onClick={() => setAdding(false)} className="h-9 px-2 text-xs text-neutral-400 hover:text-neutral-200">
                          Cancel
                        </button>
                        <p className="text-[11px] text-neutral-500 md:col-span-5">{form.prompt.length}/500 · joins the next run; use the play button on its row to ask now.</p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAdding(true)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
                      >
                        <Plus className="size-3.5" /> New prompt
                      </button>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Where to act */}
      {summary && (absentSources.length > 0 || summary.competitors.length > 0 || searches.length > 0) ? (
        <section>
          <SectionHeader label="Where to act" hint="What the assistants read where they do not find us, who they name, and what they search before answering." />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40">
              <div className="border-b border-white/[0.06] px-4 py-2.5">
                <p className="text-sm font-medium text-neutral-100">Sources cited in answers without Kodus</p>
                <p className="text-[11px] text-neutral-500">Each one is a backlink or listing target. The bar is the number of answers without Kodus that cited the domain.</p>
              </div>
              <ol className="divide-y divide-white/[0.06]">
                {absentSources.slice(0, 12).map((d) => (
                  <li key={d.domain} className="grid grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-3 px-4 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="text-neutral-100">{d.domain}</p>
                      {d.urls[0] ? (
                        <a href={d.urls[0]} target="_blank" rel="noreferrer" className="block truncate text-[11px] text-neutral-500 hover:text-neutral-300 hover:underline">
                          {d.urls[0].replace(/^https?:\/\/(www\.)?/, "")}
                        </a>
                      ) : null}
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
                      <div className="h-full rounded-full bg-amber-400/80" style={{ width: `${Math.max(3, Math.round((d.runsWithoutBrand / maxAbsent) * 100))}%` }} />
                    </div>
                    <p className="w-20 text-right text-xs tabular-nums text-neutral-400">
                      <span className="text-amber-300">{d.runsWithoutBrand}</span> / {d.citations}
                    </p>
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-4">
              <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40">
                <div className="border-b border-white/[0.06] px-4 py-2.5">
                  <p className="text-sm font-medium text-neutral-100">Who the assistants name</p>
                  <p className="text-[11px] text-neutral-500">Answers in this run naming each competitor.</p>
                </div>
                <ol className="divide-y divide-white/[0.06]">
                  {summary.competitors.slice(0, 8).map((c) => (
                    <li key={c.name} className="grid grid-cols-[minmax(0,1fr)_96px_36px] items-center gap-3 px-4 py-1.5 text-sm">
                      <span className="truncate text-neutral-200">{c.name}</span>
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
                        <div className="h-full rounded-full bg-neutral-400/70" style={{ width: `${Math.max(3, Math.round((c.runs / maxComp) * 100))}%` }} />
                      </div>
                      <span className="text-right text-xs tabular-nums text-neutral-400">{c.runs}</span>
                    </li>
                  ))}
                  {summary.competitors.length === 0 ? <li className="px-4 py-2 text-xs text-neutral-500">No competitor from the list was named.</li> : null}
                </ol>
              </div>

              {searches.length ? (
                <div className="rounded-lg border border-white/[0.06] bg-neutral-900/40">
                  <div className="border-b border-white/[0.06] px-4 py-2.5">
                    <p className="text-sm font-medium text-neutral-100">What they search before answering</p>
                    <p className="text-[11px] text-neutral-500">ChatGPT and Claude searches, plus Google related searches. Each one is a page that needs to exist and rank.</p>
                  </div>
                  <ul className="divide-y divide-white/[0.06]">
                    {shownSearches.map((sq) => (
                      <li key={sq.query} className="flex items-baseline gap-3 px-4 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate text-neutral-200" title={sq.query}>
                          {sq.query}
                        </span>
                        <span className="shrink-0 text-[11px] text-neutral-500">{sq.engines.map((e) => SHORT_LABEL[e]).join(", ")}</span>
                        <span className="w-6 shrink-0 text-right text-xs tabular-nums text-neutral-400">{sq.runs}</span>
                      </li>
                    ))}
                  </ul>
                  {searches.length > 10 ? (
                    <button type="button" onClick={() => setAllSearches((v) => !v)} className="w-full border-t border-white/[0.06] px-4 py-2 text-left text-xs text-neutral-400 hover:text-neutral-200">
                      {allSearches ? "show less" : `show all ${searches.length}`}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {summary ? <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={summary.settings} onSave={saveSettings} saving={saving} /> : null}
    </div>
  );
}

/** Two table rows per prompt need a keyed wrapper; a fragment does the job. */
function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
