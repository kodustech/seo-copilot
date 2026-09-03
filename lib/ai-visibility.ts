import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI visibility: a list of buyer prompts, asked every week to the assistants
 * people actually use, through DataForSEO's LLM Responses API (the real
 * model with web search on, not a scraped dataset). Each run keeps the
 * answer, whether the brand was named, its place in the list, which
 * competitors the model named and which pages it cited.
 *
 * The cited pages are the actionable part: a listicle the model leans on
 * where we are absent is a backlink or listing target.
 */

export const AI_ENGINES = ["perplexity", "chat_gpt", "gemini", "claude"] as const;
export type AiEngine = (typeof AI_ENGINES)[number];

export const ENGINE_LABEL: Record<AiEngine, string> = {
  perplexity: "Perplexity",
  chat_gpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
};

/** Models DataForSEO exposes per engine, verified 2026-09-03. */
export const DEFAULT_MODELS: Record<AiEngine, string> = {
  perplexity: "sonar",
  chat_gpt: "gpt-5.5",
  gemini: "gemini-3.5-flash",
  claude: "claude-sonnet-5",
};

export const WEEKDAY_LABELS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export type EngineConfig = { engine: AiEngine; model: string };

export type AiVisibilitySettings = {
  weekday: number;
  engines: EngineConfig[];
  brandTerms: string[];
  competitorTerms: string[];
  lastRunOn: string | null;
  updatedAt: string;
};

export type AiPrompt = {
  id: string;
  prompt: string;
  language: string;
  tags: string[];
  active: boolean;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Citation = { title: string | null; url: string };

export type AiPromptRun = {
  id: string;
  promptId: string;
  runOn: string;
  engine: AiEngine;
  modelName: string | null;
  mentioned: boolean;
  position: number | null;
  listSize: number | null;
  brandCited: boolean;
  competitors: string[];
  citedDomains: string[];
  citations: Citation[];
  fanOutQueries: string[];
  answer: string | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
};

type SettingsRow = {
  weekday: number;
  engines: EngineConfig[] | null;
  brand_terms: string[] | null;
  competitor_terms: string[] | null;
  last_run_on: string | null;
  updated_at: string;
};

type PromptRow = {
  id: string;
  prompt: string;
  language: string;
  tags: string[] | null;
  active: boolean;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  prompt_id: string;
  run_on: string;
  engine: string;
  model_name: string | null;
  mentioned: boolean;
  position: number | null;
  list_size: number | null;
  brand_cited: boolean;
  competitors: string[] | null;
  cited_domains: string[] | null;
  citations: Citation[] | null;
  fan_out_queries: string[] | null;
  answer: string | null;
  cost_usd: number | string | null;
  error: string | null;
  created_at: string;
};

function isEngine(v: unknown): v is AiEngine {
  return typeof v === "string" && (AI_ENGINES as readonly string[]).includes(v);
}

function rowToSettings(r: SettingsRow): AiVisibilitySettings {
  const engines = (r.engines ?? [])
    .filter((e) => e && isEngine(e.engine))
    .map((e) => ({ engine: e.engine, model: e.model?.trim() || DEFAULT_MODELS[e.engine] }));
  return {
    weekday: r.weekday,
    engines,
    brandTerms: r.brand_terms ?? [],
    competitorTerms: r.competitor_terms ?? [],
    lastRunOn: r.last_run_on,
    updatedAt: r.updated_at,
  };
}

function rowToPrompt(r: PromptRow): AiPrompt {
  return {
    id: r.id,
    prompt: r.prompt,
    language: r.language,
    tags: r.tags ?? [],
    active: r.active,
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRun(r: RunRow): AiPromptRun {
  return {
    id: r.id,
    promptId: r.prompt_id,
    runOn: r.run_on,
    engine: (isEngine(r.engine) ? r.engine : "chat_gpt") as AiEngine,
    modelName: r.model_name,
    mentioned: r.mentioned,
    position: r.position,
    listSize: r.list_size,
    brandCited: r.brand_cited,
    competitors: r.competitors ?? [],
    citedDomains: r.cited_domains ?? [],
    citations: r.citations ?? [],
    fanOutQueries: r.fan_out_queries ?? [],
    answer: r.answer,
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    error: r.error,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(client: SupabaseClient): Promise<AiVisibilitySettings> {
  const { data, error } = await client.from("ai_visibility_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(`ai_visibility_settings: ${error.message}`);
  if (!data) {
    return {
      weekday: 1,
      engines: [
        { engine: "perplexity", model: DEFAULT_MODELS.perplexity },
        { engine: "chat_gpt", model: DEFAULT_MODELS.chat_gpt },
      ],
      brandTerms: ["kodus", "kody"],
      competitorTerms: [],
      lastRunOn: null,
      updatedAt: new Date().toISOString(),
    };
  }
  return rowToSettings(data as SettingsRow);
}

export type SettingsPatch = Partial<Pick<AiVisibilitySettings, "weekday" | "engines" | "brandTerms" | "competitorTerms">>;

export async function updateSettings(client: SupabaseClient, patch: SettingsPatch): Promise<AiVisibilitySettings> {
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (patch.weekday != null) {
    if (!Number.isInteger(patch.weekday) || patch.weekday < 0 || patch.weekday > 6) throw new Error("weekday must be 0..6");
    row.weekday = patch.weekday;
  }
  if (patch.engines) {
    const engines = patch.engines.filter((e) => isEngine(e.engine)).map((e) => ({ engine: e.engine, model: e.model?.trim() || DEFAULT_MODELS[e.engine] }));
    if (engines.length === 0) throw new Error("Pick at least one assistant");
    row.engines = engines;
  }
  if (patch.brandTerms) row.brand_terms = patch.brandTerms.map((t) => t.trim()).filter(Boolean);
  if (patch.competitorTerms) row.competitor_terms = patch.competitorTerms.map((t) => t.trim()).filter(Boolean);
  const { data, error } = await client.from("ai_visibility_settings").upsert(row, { onConflict: "id" }).select("*").single();
  if (error) throw new Error(`ai_visibility_settings: ${error.message}`);
  return rowToSettings(data as SettingsRow);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export async function listPrompts(client: SupabaseClient, opts: { activeOnly?: boolean } = {}): Promise<AiPrompt[]> {
  let q = client.from("ai_prompts").select("*").order("created_at", { ascending: true });
  if (opts.activeOnly) q = q.eq("active", true);
  const { data, error } = await q.limit(500);
  if (error) throw new Error(`ai_prompts: ${error.message}`);
  return (data ?? []).map((r) => rowToPrompt(r as PromptRow));
}

export type CreatePromptInput = { prompt: string; language?: string; tags?: string[]; active?: boolean; createdByEmail?: string | null };

export async function createPrompt(client: SupabaseClient, input: CreatePromptInput): Promise<AiPrompt> {
  const prompt = input.prompt.trim();
  if (prompt.length < 5) throw new Error("Prompt too short");
  if (prompt.length > 500) throw new Error("Prompt over 500 characters (DataForSEO limit)");
  const { data, error } = await client
    .from("ai_prompts")
    .insert({
      prompt,
      language: (input.language ?? "en").trim().toLowerCase().slice(0, 5) || "en",
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      active: input.active ?? true,
      created_by_email: input.createdByEmail ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`ai_prompts: ${error.message}`);
  return rowToPrompt(data as PromptRow);
}

export async function updatePrompt(
  client: SupabaseClient,
  id: string,
  patch: Partial<Pick<AiPrompt, "prompt" | "language" | "tags" | "active">>,
): Promise<AiPrompt> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.prompt != null) {
    const p = patch.prompt.trim();
    if (p.length < 5 || p.length > 500) throw new Error("Prompt must be 5 to 500 characters");
    row.prompt = p;
  }
  if (patch.language != null) row.language = patch.language.trim().toLowerCase().slice(0, 5) || "en";
  if (patch.tags) row.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
  if (patch.active != null) row.active = patch.active;
  const { data, error } = await client.from("ai_prompts").update(row).eq("id", id).select("*").single();
  if (error) throw new Error(`ai_prompts: ${error.message}`);
  return rowToPrompt(data as PromptRow);
}

export async function deletePrompt(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("ai_prompts").delete().eq("id", id);
  if (error) throw new Error(`ai_prompts: ${error.message}`);
}

// ---------------------------------------------------------------------------
// DataForSEO LLM Responses
// ---------------------------------------------------------------------------

type DfsLlmResult = {
  model_name?: string;
  money_spent?: number;
  items?: Array<{
    type?: string;
    sections?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ title?: string | null; url?: string | null }> | null;
    }> | null;
  }> | null;
  fan_out_queries?: string[] | null;
};

type DfsLlmResponse = {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{ status_code?: number; status_message?: string; cost?: number; result?: DfsLlmResult[] | null }>;
};

export type LlmAnswer = {
  modelName: string | null;
  text: string;
  citations: Citation[];
  fanOutQueries: string[];
  costUsd: number;
  raw: unknown;
};

export function isDataForSeoConfigured(): boolean {
  return Boolean(process.env.DATAFORSEO_LOGIN?.trim() && process.env.DATAFORSEO_PASSWORD?.trim());
}

/** Ask one assistant one prompt, web search on, and flatten the answer. */
export async function askAssistant(engine: AiEngine, model: string, prompt: string): Promise<LlmAnswer> {
  const login = process.env.DATAFORSEO_LOGIN?.trim();
  const password = process.env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) throw new Error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set");
  const res = await fetch(`https://api.dataforseo.com/v3/ai_optimization/${engine}/llm_responses/live`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ user_prompt: prompt.slice(0, 500), model_name: model, web_search: true }]),
    // gpt-5.5 with web search took 16 s in testing; reasoning models can take longer.
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`DataForSEO ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as DfsLlmResponse;
  const task = json.tasks?.[0];
  if (!task || task.status_code !== 20000) {
    throw new Error(`DataForSEO task ${task?.status_code ?? json.status_code}: ${task?.status_message ?? json.status_message ?? "no task"}`);
  }
  const result = task.result?.[0];
  if (!result) throw new Error("DataForSEO returned no result");
  const texts: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const item of result.items ?? []) {
    if (item.type !== "message") continue;
    for (const s of item.sections ?? []) {
      if (s.type === "text" && s.text) texts.push(s.text);
      for (const a of s.annotations ?? []) {
        const url = a.url?.trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        citations.push({ title: a.title ?? null, url });
      }
    }
  }
  return {
    modelName: result.model_name ?? model,
    text: texts.join("\n\n"),
    citations,
    fanOutQueries: result.fan_out_queries ?? [],
    costUsd: Number(task.cost ?? result.money_spent ?? json.cost ?? 0),
    raw: json,
  };
}

// ---------------------------------------------------------------------------
// Answer analysis
// ---------------------------------------------------------------------------

export type Analysis = {
  mentioned: boolean;
  position: number | null;
  listSize: number | null;
  brandCited: boolean;
  competitors: string[];
  citedDomains: string[];
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term: string): RegExp {
  // Word boundaries on both sides, so "Kody" does not fire on "Kodyak" and
  // "Copilot" does not swallow "GitHub Copilot" twice; case-insensitive.
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}(?=$|[^a-z0-9])`, "i");
}

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const OWN_DOMAINS = ["kodus.io", "trykodus.com", "github.com/kodustech"];

/**
 * Read the answer the way a buyer would: is the brand there, which place in
 * the list, who else is named, and which pages the model relied on.
 */
export function analyzeAnswer(text: string, citations: Citation[], brandTerms: string[], competitorTerms: string[]): Analysis {
  const brand = brandTerms.filter(Boolean);
  const brandRe = brand.map(termRegex);
  const mentioned = brandRe.some((re) => re.test(text));

  // List items: "1. ", "1) ", "- ", "* ", "• " at line start (markdown bold
  // prefixes tolerated). Position is the first item naming the brand.
  const lines = text.split(/\r?\n/);
  const itemRe = /^\s*(?:\*\*)?(?:(\d{1,2})[.)]|[-*•])\s+/;
  let listSize = 0;
  let position: number | null = null;
  for (const line of lines) {
    const m = line.match(itemRe);
    if (!m) continue;
    listSize += 1;
    if (position == null && brandRe.some((re) => re.test(line))) {
      const numbered = m[1] ? Number(m[1]) : NaN;
      position = Number.isFinite(numbered) && numbered > 0 ? numbered : listSize;
    }
  }

  const competitors: string[] = [];
  const brandLower = new Set(brand.map((b) => b.toLowerCase()));
  for (const term of competitorTerms) {
    if (!term || brandLower.has(term.toLowerCase())) continue;
    if (termRegex(term).test(text) && !competitors.includes(term)) competitors.push(term);
  }

  const citedDomains: string[] = [];
  let brandCited = false;
  for (const c of citations) {
    const d = domainOf(c.url);
    if (!d) continue;
    if (!citedDomains.includes(d)) citedDomains.push(d);
    const lower = c.url.toLowerCase();
    if (OWN_DOMAINS.some((own) => lower.includes(own))) brandCited = true;
  }

  return {
    mentioned,
    position: mentioned ? position : null,
    listSize: listSize > 0 ? listSize : null,
    brandCited,
    competitors,
    citedDomains,
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunOptions = {
  promptIds?: string[];
  engines?: EngineConfig[];
  /** ISO date the run is filed under; default today (UTC). */
  runOn?: string;
  /** Re-ask prompts that already have a run for that day and engine. */
  force?: boolean;
  concurrency?: number;
};

export type RunSummary = {
  runOn: string;
  asked: number;
  skipped: number;
  mentioned: number;
  failed: number;
  costUsd: number;
  errors: string[];
};

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runAiVisibility(client: SupabaseClient, opts: RunOptions = {}): Promise<RunSummary> {
  const settings = await getSettings(client);
  const engines = opts.engines?.length ? opts.engines : settings.engines;
  const runOn = opts.runOn ?? todayIso();
  const prompts = (await listPrompts(client, { activeOnly: true })).filter(
    (p) => !opts.promptIds || opts.promptIds.includes(p.id),
  );
  const summary: RunSummary = { runOn, asked: 0, skipped: 0, mentioned: 0, failed: 0, costUsd: 0, errors: [] };
  if (prompts.length === 0 || engines.length === 0) return summary;

  // What already exists for the day, so a re-run after a crash only asks
  // what is missing.
  const existing = new Set<string>();
  if (!opts.force) {
    const { data } = await client
      .from("ai_prompt_runs")
      .select("prompt_id,engine")
      .eq("run_on", runOn)
      .is("error", null)
      .in("prompt_id", prompts.map((p) => p.id));
    for (const r of data ?? []) existing.add(`${r.prompt_id}:${r.engine}`);
  }

  const jobs: Array<{ prompt: AiPrompt; engine: EngineConfig }> = [];
  for (const prompt of prompts) {
    for (const engine of engines) {
      if (existing.has(`${prompt.id}:${engine.engine}`)) {
        summary.skipped += 1;
        continue;
      }
      jobs.push({ prompt, engine });
    }
  }

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const base = {
        prompt_id: job.prompt.id,
        run_on: runOn,
        engine: job.engine.engine,
        model_name: job.engine.model,
      };
      try {
        const answer = await askAssistant(job.engine.engine, job.engine.model, job.prompt.prompt);
        const a = analyzeAnswer(answer.text, answer.citations, settings.brandTerms, settings.competitorTerms);
        const { error } = await client.from("ai_prompt_runs").upsert(
          {
            ...base,
            model_name: answer.modelName ?? job.engine.model,
            mentioned: a.mentioned,
            position: a.position,
            list_size: a.listSize,
            brand_cited: a.brandCited,
            competitors: a.competitors,
            cited_domains: a.citedDomains,
            citations: answer.citations,
            fan_out_queries: answer.fanOutQueries,
            answer: answer.text,
            cost_usd: answer.costUsd,
            error: null,
            raw: answer.raw,
          },
          { onConflict: "prompt_id,engine,run_on" },
        );
        if (error) throw new Error(error.message);
        summary.asked += 1;
        summary.costUsd += answer.costUsd;
        if (a.mentioned) summary.mentioned += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.failed += 1;
        summary.errors.push(`${ENGINE_LABEL[job.engine.engine]} · ${job.prompt.prompt.slice(0, 60)}: ${message}`);
        await client.from("ai_prompt_runs").upsert(
          { ...base, mentioned: false, error: message.slice(0, 500), answer: null },
          { onConflict: "prompt_id,engine,run_on" },
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  if (summary.asked > 0) {
    await client.from("ai_visibility_settings").upsert({ id: 1, last_run_on: runOn, updated_at: new Date().toISOString() }, { onConflict: "id" });
  }
  summary.costUsd = Math.round(summary.costUsd * 1e6) / 1e6;
  return summary;
}

/** The weekly cron asks once on the configured weekday (UTC). */
export function isDueToday(settings: AiVisibilitySettings, now = new Date()): boolean {
  if (now.getUTCDay() !== settings.weekday) return false;
  return settings.lastRunOn !== now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Summary for the page and the agent
// ---------------------------------------------------------------------------

export type EngineSummary = {
  engine: AiEngine;
  label: string;
  model: string | null;
  prompts: number;
  mentioned: number;
  share: number | null;
  avgPosition: number | null;
  brandCited: number;
  costUsd: number;
  failed: number;
};

export type PromptSummary = {
  prompt: AiPrompt;
  runs: Partial<Record<AiEngine, AiPromptRun>>;
};

export type DomainSummary = {
  domain: string;
  citations: number;
  /** Runs citing this domain where the brand was NOT named. */
  runsWithoutBrand: number;
  /** Example URLs, at most three. */
  urls: string[];
};

export type CompetitorSummary = { name: string; runs: number };

export type VisibilitySummary = {
  runOn: string | null;
  settings: AiVisibilitySettings;
  engines: EngineSummary[];
  prompts: PromptSummary[];
  domains: DomainSummary[];
  competitors: CompetitorSummary[];
  totalCostUsd: number;
  /** Share of prompt × engine pairs naming the brand, across engines. */
  overallShare: number | null;
  history: Array<{ runOn: string; engine: AiEngine; prompts: number; mentioned: number }>;
};

export async function getVisibilitySummary(client: SupabaseClient, opts: { runOn?: string } = {}): Promise<VisibilitySummary> {
  const [settings, prompts] = await Promise.all([getSettings(client), listPrompts(client)]);
  // Latest run date, or the one asked for.
  let runOn = opts.runOn ?? null;
  if (!runOn) {
    const { data } = await client.from("ai_prompt_runs").select("run_on").order("run_on", { ascending: false }).limit(1);
    runOn = (data?.[0]?.run_on as string | undefined) ?? null;
  }
  const empty: VisibilitySummary = {
    runOn,
    settings,
    engines: [],
    prompts: prompts.map((p) => ({ prompt: p, runs: {} })),
    domains: [],
    competitors: [],
    totalCostUsd: 0,
    overallShare: null,
    history: [],
  };
  if (!runOn) return empty;

  const [{ data: runRows, error }, { data: histRows }] = await Promise.all([
    client.from("ai_prompt_runs").select("*").eq("run_on", runOn).limit(2000),
    client.from("ai_prompt_runs").select("run_on,engine,mentioned,error").order("run_on", { ascending: false }).limit(5000),
  ]);
  if (error) throw new Error(`ai_prompt_runs: ${error.message}`);
  const runs = (runRows ?? []).map((r) => rowToRun(r as RunRow));

  const byPrompt = new Map<string, Partial<Record<AiEngine, AiPromptRun>>>();
  for (const r of runs) {
    const m = byPrompt.get(r.promptId) ?? {};
    m[r.engine] = r;
    byPrompt.set(r.promptId, m);
  }

  const engineAgg = new Map<AiEngine, EngineSummary & { positions: number[] }>();
  const domainAgg = new Map<string, DomainSummary>();
  const compAgg = new Map<string, number>();
  let pairs = 0;
  let pairsMentioned = 0;
  for (const r of runs) {
    const e =
      engineAgg.get(r.engine) ??
      {
        engine: r.engine,
        label: ENGINE_LABEL[r.engine],
        model: r.modelName,
        prompts: 0,
        mentioned: 0,
        share: null,
        avgPosition: null,
        brandCited: 0,
        costUsd: 0,
        failed: 0,
        positions: [],
      };
    e.costUsd += r.costUsd ?? 0;
    if (r.error) {
      e.failed += 1;
    } else {
      e.prompts += 1;
      pairs += 1;
      if (r.mentioned) {
        e.mentioned += 1;
        pairsMentioned += 1;
        if (r.position != null) e.positions.push(r.position);
      }
      if (r.brandCited) e.brandCited += 1;
      for (const c of r.citations) {
        const d = domainOf(c.url);
        if (!d) continue;
        const agg = domainAgg.get(d) ?? { domain: d, citations: 0, runsWithoutBrand: 0, urls: [] };
        agg.citations += 1;
        if (!r.mentioned) agg.runsWithoutBrand += 1;
        if (agg.urls.length < 3 && !agg.urls.includes(c.url)) agg.urls.push(c.url);
        domainAgg.set(d, agg);
      }
      for (const name of r.competitors) compAgg.set(name, (compAgg.get(name) ?? 0) + 1);
    }
    engineAgg.set(r.engine, e);
  }

  const engines: EngineSummary[] = [...engineAgg.values()].map(({ positions, ...e }) => ({
    ...e,
    share: e.prompts ? e.mentioned / e.prompts : null,
    avgPosition: positions.length ? Math.round((positions.reduce((s, p) => s + p, 0) / positions.length) * 10) / 10 : null,
    costUsd: Math.round(e.costUsd * 1e4) / 1e4,
  }));
  engines.sort((a, b) => AI_ENGINES.indexOf(a.engine) - AI_ENGINES.indexOf(b.engine));

  const ownDomains = new Set(["kodus.io", "trykodus.com"]);
  const domains = [...domainAgg.values()]
    .filter((d) => !ownDomains.has(d.domain))
    .sort((a, b) => b.runsWithoutBrand - a.runsWithoutBrand || b.citations - a.citations)
    .slice(0, 40);

  const competitors = [...compAgg.entries()].map(([name, n]) => ({ name, runs: n })).sort((a, b) => b.runs - a.runs);

  // Weekly history per engine, oldest first, for the trend line.
  const histAgg = new Map<string, { runOn: string; engine: AiEngine; prompts: number; mentioned: number }>();
  for (const h of histRows ?? []) {
    if (h.error || !isEngine(h.engine)) continue;
    const key = `${h.run_on}:${h.engine}`;
    const agg = histAgg.get(key) ?? { runOn: String(h.run_on), engine: h.engine, prompts: 0, mentioned: 0 };
    agg.prompts += 1;
    if (h.mentioned) agg.mentioned += 1;
    histAgg.set(key, agg);
  }
  const history = [...histAgg.values()].sort((a, b) => a.runOn.localeCompare(b.runOn) || a.engine.localeCompare(b.engine));

  return {
    runOn,
    settings,
    engines,
    prompts: prompts.map((p) => ({ prompt: p, runs: byPrompt.get(p.id) ?? {} })),
    domains,
    competitors,
    totalCostUsd: Math.round(runs.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 1e4) / 1e4,
    overallShare: pairs ? pairsMentioned / pairs : null,
    history,
  };
}

/** Distinct run dates, newest first, for the date picker. */
export async function listRunDates(client: SupabaseClient, limit = 26): Promise<string[]> {
  const { data, error } = await client.from("ai_prompt_runs").select("run_on").order("run_on", { ascending: false }).limit(5000);
  if (error) throw new Error(`ai_prompt_runs: ${error.message}`);
  const out: string[] = [];
  for (const r of data ?? []) {
    const d = String(r.run_on);
    if (!out.includes(d)) out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}
