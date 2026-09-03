"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2, Play, RefreshCw, Settings2, Trash2 } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const LANGS = [
  { value: "en", label: "EN" },
  { value: "pt", label: "PT" },
];

function pct(n: number | null): string {
  return n == null ? "–" : `${Math.round(n * 100)}%`;
}

function usd(n: number | null | undefined): string {
  return n == null ? "–" : `US$ ${n.toFixed(2)}`;
}

/** One cell: how many samples named the brand, and where in the list. */
function RunCell({ result, onOpen }: { result: PromptEngineResult | undefined; onOpen: () => void }) {
  if (!result) return <span className="text-neutral-700">–</span>;
  if (result.samples === 0) {
    return (
      <button onClick={onOpen} title={result.error ?? "erro"} className="text-xs text-amber-300 hover:underline">
        erro
      </button>
    );
  }
  const rate = result.rate ?? 0;
  const dot = rate >= 1 ? "bg-emerald-400" : rate > 0 ? "bg-amber-400" : "bg-red-400/80";
  const label =
    result.samples > 1 ? `${result.mentioned} de ${result.samples}` : result.mentioned ? (result.avgPosition != null ? `#${result.avgPosition}` : "citado") : "ausente";
  return (
    <button onClick={onOpen} className="flex items-center gap-1.5 text-xs hover:underline">
      <span className={cn("inline-block size-2 rounded-full", dot)} />
      <span className={rate > 0 ? "text-emerald-200" : "text-neutral-400"}>{label}</span>
      {result.samples > 1 && result.avgPosition != null ? <span className="text-neutral-500">· #{result.avgPosition}</span> : null}
      {result.samples === 1 && result.mentioned && result.listSize != null && result.avgPosition != null ? <span className="text-neutral-500">de {result.listSize}</span> : null}
      {result.engine === "google_ai" && result.extra.aiOverview === false ? <span className="text-neutral-600">· sem overview</span> : null}
      {result.engine === "google_ai" && result.extra.organicRank != null ? <span className="text-neutral-500">· orgânico #{result.extra.organicRank}</span> : null}
      {result.brandCited ? <span title="Citou uma página nossa" className="text-neutral-500">· fonte</span> : null}
    </button>
  );
}

function AnswerPanel({ run, total }: { run: AiPromptRun; total: number }) {
  return (
    <div className="space-y-2 rounded-md border border-white/10 bg-neutral-950 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-neutral-400">
        <span className="font-medium text-neutral-200">{ENGINE_LABEL[run.engine]}</span>
        {total > 1 ? <span>· amostra {run.sample} de {total}</span> : null}
        <span>· {run.modelName ?? "modelo?"}</span>
        <span>· {run.runOn}</span>
        {run.mentioned ? <span className="text-emerald-300">· Kodus {run.position != null ? `#${run.position}` : "citado"}</span> : <span className="text-red-300">· ausente</span>}
        {run.engine === "google_ai" ? (
          <span>
            · AI Overview {run.extra.aiOverview ? "presente" : "ausente"}
            {run.extra.organicRank != null ? ` · kodus.io orgânico #${run.extra.organicRank}` : " · kodus.io fora do top 10"}
          </span>
        ) : null}
        {run.costUsd != null ? <span>· {usd(run.costUsd)}</span> : null}
        {run.competitors.length ? <span>· cita: {run.competitors.join(", ")}</span> : null}
      </div>
      {run.error ? <p className="text-amber-300">{run.error}</p> : null}
      {run.answer ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-sans text-neutral-300">{run.answer}</pre> : null}
      {run.citations.length ? (
        <div>
          <p className="mb-1 text-neutral-500">Fontes citadas</p>
          <ul className="space-y-0.5">
            {run.citations.map((c) => (
              <li key={c.url} className="truncate">
                <a href={c.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                  {c.title || c.url}
                </a>
                <span className="ml-1 text-neutral-600">{c.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.fanOutQueries.length ? (
        <p className="text-neutral-500">
          {run.engine === "google_ai" ? "Buscas relacionadas" : "O modelo pesquisou"}: {run.fanOutQueries.map((q) => `“${q}”`).join(", ")}
        </p>
      ) : null}
      {run.engine === "google_ai" && run.extra.organicTop?.length ? (
        <p className="text-neutral-500">Top 10 orgânico: {run.extra.organicTop.join(", ")}</p>
      ) : null}
    </div>
  );
}

function SettingsPanel({
  settings,
  onSave,
  saving,
}: {
  settings: AiVisibilitySettings;
  onSave: (patch: { weekday: number; engines: EngineConfig[] }) => Promise<void>;
  saving: boolean;
}) {
  const [weekday, setWeekday] = useState(settings.weekday);
  const [engines, setEngines] = useState<EngineConfig[]>(settings.engines);
  useEffect(() => {
    setWeekday(settings.weekday);
    setEngines(settings.engines);
  }, [settings]);

  const toggle = (engine: AiEngine) => {
    setEngines((list) =>
      list.some((e) => e.engine === engine)
        ? list.filter((e) => e.engine !== engine)
        : [...list, { engine, model: DEFAULT_MODELS[engine], samples: DEFAULT_SAMPLES[engine] }],
    );
  };
  const setModel = (engine: AiEngine, model: string) => {
    setEngines((list) => list.map((e) => (e.engine === engine ? { ...e, model } : e)));
  };
  const setSamples = (engine: AiEngine, samples: number) => {
    setEngines((list) => list.map((e) => (e.engine === engine ? { ...e, samples: Math.max(1, Math.min(MAX_SAMPLES, samples || 1)) } : e)));
  };
  const dirty = weekday !== settings.weekday || JSON.stringify(engines) !== JSON.stringify(settings.engines);

  return (
    <div className="rounded-xl border border-white/10 bg-neutral-900/60 p-4">
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">Roda toda</p>
          <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
            <SelectTrigger className="h-9 border-white/10 bg-neutral-900 text-sm">
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
          <p className="mt-1 text-[11px] text-neutral-500">Às 07:00 UTC (04:00 em Brasília). Última: {settings.lastRunOn ?? "nunca"}.</p>
        </div>
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">Assistentes e modelo</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {AI_ENGINES.map((engine) => {
              const cfg = engines.find((e) => e.engine === engine);
              return (
                <label key={engine} className="flex items-center gap-2 rounded-md border border-white/10 px-2 py-1.5 text-sm">
                  <input type="checkbox" checked={Boolean(cfg)} onChange={() => toggle(engine)} className="accent-violet-500" />
                  <span className="w-28 shrink-0 text-neutral-200">{ENGINE_LABEL[engine]}</span>
                  {engine === "google_ai" ? (
                    <span className="flex-1 text-xs text-neutral-500">SERP com AI Overview</span>
                  ) : (
                    <Input
                      value={cfg?.model ?? DEFAULT_MODELS[engine]}
                      disabled={!cfg}
                      onChange={(e) => setModel(engine, e.target.value)}
                      className="h-7 border-white/10 bg-neutral-950 text-xs"
                    />
                  )}
                  <span className="text-[11px] text-neutral-500" title="Amostras por prompt">×</span>
                  <Input
                    type="number"
                    min={1}
                    max={MAX_SAMPLES}
                    value={cfg?.samples ?? DEFAULT_SAMPLES[engine]}
                    disabled={!cfg}
                    onChange={(e) => setSamples(engine, Number(e.target.value))}
                    className="h-7 w-14 border-white/10 bg-neutral-950 text-xs"
                    title="Amostras por prompt"
                  />
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">
            Amostras: quantas vezes cada prompt é perguntado por rodada; a resposta varia, e a taxa é lida sobre as amostras. Custo medido por pergunta: Perplexity sonar US$ 0,006; ChatGPT gpt-5.5 US$ 0,09; Google AI Overview US$ 0,003. Gemini e Claude na faixa do ChatGPT.
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          onClick={() => onSave({ weekday, engines })}
          disabled={!dirty || saving || engines.length === 0}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {saving ? "salvando..." : "salvar"}
        </button>
      </div>
    </div>
  );
}

export function AiVisibilityPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [summary, setSummary] = useState<VisibilitySummary | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [runOn, setRunOn] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [open, setOpen] = useState<Record<string, AiEngine | null>>({});
  const [form, setForm] = useState({ prompt: "", language: "en", tags: "" });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: s }) => setToken(s.session?.access_token ?? null));
  }, [supabase]);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai-visibility/summary${runOn ? `?runOn=${runOn}` : ""}`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Falha ao carregar");
      setSummary(json.summary as VisibilitySummary);
      setDates(json.dates as string[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao carregar";
      setError(
        /ai_prompts|ai_visibility_settings|ai_prompt_runs/.test(msg) && /schema cache|does not exist/.test(msg)
          ? "As tabelas de AI visibility ainda não existem neste ambiente. Rode a migration supabase/migrations/20260903150000_ai_visibility.sql."
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

  const saveSettings = async (patch: { weekday: number; engines: EngineConfig[] }) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-visibility/settings", { method: "PATCH", headers, body: JSON.stringify(patch) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Falhou");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falhou");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (promptIds?: string[]) => {
    setRunning(true);
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
      setRunning(false);
    }
  };

  const addPrompt = async () => {
    setAdding(true);
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falhou");
    } finally {
      setAdding(false);
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
    if (!window.confirm("Apagar o prompt e o histórico dele?")) return;
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Bot className="size-5 text-violet-400" /> AI visibility
          </h1>
          <p className="text-sm text-muted-foreground">
            Prompts de comprador perguntados toda semana aos assistentes, com busca web ligada. O que interessa: se o Kodus aparece, em que posição, contra quem, e quais páginas o modelo cita.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dates.length > 1 ? (
            <Select value={runOn ?? dates[0]} onValueChange={(v) => setRunOn(v === dates[0] ? null : v)}>
              <SelectTrigger className="h-9 w-[150px] border-white/10 bg-neutral-900 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                {dates.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <button onClick={() => setShowSettings((v) => !v)} className="flex h-9 items-center gap-1.5 rounded-md border border-white/10 px-3 text-xs text-neutral-300 hover:bg-white/5">
            <Settings2 className="size-3.5" /> {summary ? `${WEEKDAY_LABELS[summary.settings.weekday]} · ${engines.map((e) => ENGINE_LABEL[e]).join(" + ") || "sem assistente"}` : "configurar"}
          </button>
          <button onClick={() => load()} className="flex h-9 items-center gap-1.5 rounded-md border border-white/10 px-3 text-xs text-neutral-300 hover:bg-white/5">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
          <button
            onClick={() => runNow()}
            disabled={running || activeCount === 0}
            className="flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            title="Pergunta agora os prompts ativos que ainda não foram perguntados hoje"
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} rodar agora
          </button>
        </div>
      </div>

      {error ? <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p> : null}
      {lastRun ? (
        <p className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
          Rodou: {lastRun.asked} perguntas, Kodus em {lastRun.mentioned}, {lastRun.skipped} já feitas hoje, {lastRun.failed} falhas, {usd(lastRun.costUsd)}.
          {lastRun.errors.length ? ` Erros: ${lastRun.errors.slice(0, 2).join(" | ")}` : ""}
        </p>
      ) : null}

      {showSettings && summary ? <SettingsPanel settings={summary.settings} onSave={saveSettings} saving={saving} /> : null}

      {/* Per-engine summary */}
      {summary && summary.engines.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summary.engines.map((e) => (
            <div key={e.engine} className="rounded-xl border border-white/10 bg-neutral-900/60 p-3">
              <p className="text-[11px] uppercase tracking-wider text-neutral-500">
                {e.label} <span className="normal-case tracking-normal text-neutral-600">· {e.model}</span>
              </p>
              <p className="mt-1 text-2xl font-semibold text-neutral-100">
                {pct(e.share)}
                {e.rollingRuns > 1 && e.rollingShare != null ? (
                  <span className="ml-2 text-sm font-normal text-neutral-500" title={`Média das últimas ${e.rollingRuns} rodadas`}>
                    {pct(e.rollingShare)} em {e.rollingRuns} rodadas
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-neutral-400">
                Kodus em {e.mentioned} de {e.samples} amostra{e.samples === 1 ? "" : "s"} · {e.promptsMentioned} de {e.prompts} prompts
                {e.avgPosition != null ? ` · posição média ${e.avgPosition}` : ""}
                {e.brandCited ? ` · nossa página citada ${e.brandCited}x` : ""}
              </p>
              <p className="mt-1 text-[11px] text-neutral-600">
                {usd(e.costUsd)}
                {e.failed ? ` · ${e.failed} falha${e.failed === 1 ? "" : "s"}` : ""}
              </p>
            </div>
          ))}
          <div className="rounded-xl border border-white/10 bg-neutral-900/60 p-3">
            <p className="text-[11px] uppercase tracking-wider text-neutral-500">Rodada {summary.runOn}</p>
            <p className="mt-1 text-2xl font-semibold text-neutral-100">{pct(summary.overallShare)}</p>
            <p className="text-xs text-neutral-400">amostras com Kodus, todos os assistentes · {usd(summary.totalCostUsd)}</p>
            {summary.history.length > 1 ? (
              <p className="mt-1 text-[11px] text-neutral-600">{[...new Set(summary.history.map((h) => h.runOn))].length} rodadas no histórico</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Prompts */}
      <div className="rounded-xl border border-white/10 bg-neutral-900/40">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <p className="text-sm font-medium text-neutral-200">
            Prompts <span className="text-neutral-500">· {activeCount} ativos</span>
          </p>
          {summary?.runOn ? <p className="text-[11px] text-neutral-500">resultado de {summary.runOn}</p> : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">Prompt</th>
                {engines.map((e) => (
                  <th key={e} className="px-3 py-2 text-left font-normal">
                    {ENGINE_LABEL[e]}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-normal">Concorrentes citados</th>
                <th className="px-3 py-2 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {summary?.prompts.map(({ prompt, runs }) => {
                const comps = [...new Set(Object.values(runs).flatMap((r) => r?.competitors ?? []))];
                const openEngine = open[prompt.id] ?? null;
                const openResult = openEngine ? runs[openEngine] : undefined;
                return (
                  <FragmentRow key={prompt.id}>
                    <tr className={cn("border-t border-white/5", !prompt.active && "opacity-50")}>
                      <td className="max-w-[520px] px-4 py-2 align-top">
                        <div className="flex items-start gap-2">
                          <button
                            onClick={() => setOpen((o) => ({ ...o, [prompt.id]: openEngine ? null : engines.find((e) => runs[e]) ?? null }))}
                            className="mt-0.5 text-neutral-500 hover:text-neutral-200"
                            aria-label="Ver respostas"
                          >
                            {openEngine ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                          </button>
                          <div className="min-w-0">
                            <p className="text-neutral-100">{prompt.prompt}</p>
                            <p className="text-[11px] text-neutral-500">
                              {prompt.language.toUpperCase()}
                              {prompt.tags.length ? ` · ${prompt.tags.join(", ")}` : ""}
                              {!prompt.active ? " · pausado" : ""}
                            </p>
                          </div>
                        </div>
                      </td>
                      {engines.map((e) => (
                        <td key={e} className="px-3 py-2 align-top">
                          <RunCell result={runs[e]} onOpen={() => setOpen((o) => ({ ...o, [prompt.id]: o[prompt.id] === e ? null : e }))} />
                        </td>
                      ))}
                      <td className="px-3 py-2 align-top text-xs text-neutral-400">{comps.slice(0, 5).join(", ")}{comps.length > 5 ? ` +${comps.length - 5}` : ""}</td>
                      <td className="px-3 py-2 text-right align-top">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => runNow([prompt.id])}
                            disabled={running}
                            title="Perguntar só este agora"
                            className="rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-200 disabled:opacity-40"
                          >
                            <Play className="size-3.5" />
                          </button>
                          <button
                            onClick={() => patchPrompt(prompt.id, { active: !prompt.active })}
                            title={prompt.active ? "Pausar" : "Ativar"}
                            className="rounded px-1.5 text-[11px] text-neutral-500 hover:bg-white/5 hover:text-neutral-200"
                          >
                            {prompt.active ? "pausar" : "ativar"}
                          </button>
                          <button onClick={() => removePrompt(prompt.id)} title="Apagar" className="rounded p-1 text-neutral-600 hover:bg-red-500/10 hover:text-red-300">
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {openEngine ? (
                      <tr className="border-t border-white/5 bg-black/20">
                        <td colSpan={engines.length + 3} className="px-4 py-3">
                          <div className="mb-2 flex gap-2">
                            {engines
                              .filter((e) => runs[e])
                              .map((e) => (
                                <button
                                  key={e}
                                  onClick={() => setOpen((o) => ({ ...o, [prompt.id]: e }))}
                                  className={cn("rounded px-2 py-0.5 text-xs", e === openEngine ? "bg-violet-500/20 text-violet-200" : "text-neutral-400 hover:bg-white/5")}
                                >
                                  {ENGINE_LABEL[e]}
                                </button>
                              ))}
                          </div>
                          {openResult && openResult.runs.length ? (
                            <div className="space-y-2">
                              {openResult.runs.map((run) => (
                                <AnswerPanel key={run.id} run={run} total={openResult.runs.length} />
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-neutral-500">Sem resposta nesta rodada.</p>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </FragmentRow>
                );
              })}
              {summary && summary.prompts.length === 0 ? (
                <tr>
                  <td colSpan={engines.length + 3} className="px-4 py-6 text-center text-sm text-neutral-500">
                    Nenhum prompt ainda. Escreva a pergunta como um comprador escreveria.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="border-t border-white/10 p-3">
          <div className="grid gap-2 md:grid-cols-[1fr_90px_200px_auto]">
            <Textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="Ex.: What are the best AI code review tools for a team on GitLab that wants a self-hosted option?"
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
              onClick={addPrompt}
              disabled={adding || form.prompt.trim().length < 5}
              className="h-9 rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {adding ? "salvando..." : "+ prompt"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">{form.prompt.length}/500. Um prompt novo entra na próxima rodada; use o play na linha pra perguntar agora.</p>
        </div>
      </div>

      {/* What the assistants searched before answering */}
      {summary && summary.searches.length > 0 ? (
        <div className="rounded-xl border border-white/10 bg-neutral-900/40">
          <div className="border-b border-white/10 px-4 py-2">
            <p className="text-sm font-medium text-neutral-200">Buscas que os assistentes fazem antes de responder</p>
            <p className="text-[11px] text-neutral-500">
              O ChatGPT pesquisa na web antes de responder; o Google traz as buscas relacionadas. Cada linha é uma página que precisa existir no kodus.io e ranquear.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">Busca</th>
                <th className="px-3 py-2 text-right font-normal">Vezes</th>
                <th className="px-3 py-2 text-right font-normal">Prompts</th>
                <th className="px-3 py-2 text-left font-normal">Onde</th>
              </tr>
            </thead>
            <tbody>
              {summary.searches.slice(0, 25).map((sq) => (
                <tr key={sq.query} className="border-t border-white/5">
                  <td className="px-4 py-1.5 text-neutral-100">{sq.query}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-300">{sq.runs}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-400">{sq.prompts}</td>
                  <td className="px-3 py-1.5 text-xs text-neutral-500">{sq.engines.map((e) => ENGINE_LABEL[e]).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Sources the models lean on */}
      {summary && summary.domains.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-xl border border-white/10 bg-neutral-900/40">
            <div className="border-b border-white/10 px-4 py-2">
              <p className="text-sm font-medium text-neutral-200">Páginas que os assistentes citam</p>
              <p className="text-[11px] text-neutral-500">Ordenado por respostas sem o Kodus. Cada uma é um alvo de backlink ou listing.</p>
            </div>
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="px-4 py-2 text-left font-normal">Domínio</th>
                  <th className="px-3 py-2 text-right font-normal">Citações</th>
                  <th className="px-3 py-2 text-right font-normal">Sem Kodus</th>
                  <th className="px-3 py-2 text-left font-normal">Exemplo</th>
                </tr>
              </thead>
              <tbody>
                {summary.domains.slice(0, 20).map((d) => (
                  <tr key={d.domain} className="border-t border-white/5">
                    <td className="px-4 py-1.5 text-neutral-100">{d.domain}</td>
                    <td className="px-3 py-1.5 text-right text-neutral-300">{d.citations}</td>
                    <td className={cn("px-3 py-1.5 text-right", d.runsWithoutBrand ? "text-amber-300" : "text-neutral-500")}>{d.runsWithoutBrand}</td>
                    <td className="max-w-[360px] truncate px-3 py-1.5 text-xs">
                      <a href={d.urls[0]} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                        {d.urls[0]?.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-white/10 bg-neutral-900/40">
            <div className="border-b border-white/10 px-4 py-2">
              <p className="text-sm font-medium text-neutral-200">Quem mais aparece</p>
              <p className="text-[11px] text-neutral-500">Respostas desta rodada que nomeiam cada concorrente.</p>
            </div>
            <ul className="p-2">
              {summary.competitors.slice(0, 15).map((c) => (
                <li key={c.name} className="flex items-center justify-between px-2 py-1 text-sm">
                  <span className="text-neutral-200">{c.name}</span>
                  <span className="text-neutral-400">{c.runs}</span>
                </li>
              ))}
              {summary.competitors.length === 0 ? <li className="px-2 py-1 text-xs text-neutral-500">Nenhum concorrente da lista foi citado.</li> : null}
            </ul>
          </div>
        </div>
      ) : null}

      {loading && !summary ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-neutral-600" />
        </div>
      ) : null}
    </div>
  );
}

/** Two table rows per prompt need a keyed wrapper; a fragment does the job. */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
