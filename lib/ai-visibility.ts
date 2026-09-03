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

export const AI_ENGINES = ["perplexity", "chat_gpt", "gemini", "claude", "google_ai"] as const;
export type AiEngine = (typeof AI_ENGINES)[number];

export const ENGINE_LABEL: Record<AiEngine, string> = {
  perplexity: "Perplexity",
  chat_gpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  google_ai: "Google AI Overview",
};

/**
 * Models DataForSEO exposes per engine, verified 2026-09-03. Google AI
 * Overview is not a model call but a SERP with the overview loaded; the
 * "model" is a fixed label.
 */
export const DEFAULT_MODELS: Record<AiEngine, string> = {
  perplexity: "sonar",
  chat_gpt: "gpt-5.5",
  gemini: "gemini-3.5-flash",
  claude: "claude-sonnet-5",
  google_ai: "ai_overview",
};

/**
 * Answers vary between runs, so a prompt is asked several times where it is
 * cheap (Perplexity sonar is under a cent) and the share is read over
 * samples. Expensive engines default to one.
 */
export const DEFAULT_SAMPLES: Record<AiEngine, number> = {
  perplexity: 3,
  chat_gpt: 1,
  gemini: 1,
  claude: 1,
  google_ai: 1,
};
export const MAX_SAMPLES = 5;

/** Runs (distinct dates) the rolling share averages over. */
export const ROLLING_RUNS = 4;

export const WEEKDAY_LABELS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export type EngineConfig = { engine: AiEngine; model: string; samples: number };

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

/** Engine-specific facts of a run; Google AI Overview fills these. */
export type RunExtra = {
  aiOverview?: boolean;
  organicRank?: number | null;
  organicTop?: string[];
};

export type AiPromptRun = {
  id: string;
  promptId: string;
  runOn: string;
  engine: AiEngine;
  sample: number;
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
  extra: RunExtra;
  createdAt: string;
};

type SettingsRow = {
  weekday: number;
  engines: Array<Partial<EngineConfig>> | null;
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
  sample: number | null;
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
  extra: RunExtra | null;
  created_at: string;
};

function isEngine(v: unknown): v is AiEngine {
  return typeof v === "string" && (AI_ENGINES as readonly string[]).includes(v);
}

function normalizeSamples(engine: AiEngine, v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SAMPLES[engine];
  return Math.min(MAX_SAMPLES, Math.round(n));
}

function normalizeEngines(list: Array<Partial<EngineConfig>> | null | undefined): EngineConfig[] {
  return (list ?? [])
    .filter((e): e is Partial<EngineConfig> & { engine: AiEngine } => Boolean(e) && isEngine(e.engine))
    .map((e) => ({ engine: e.engine, model: e.model?.trim() || DEFAULT_MODELS[e.engine], samples: normalizeSamples(e.engine, e.samples) }));
}

function rowToSettings(r: SettingsRow): AiVisibilitySettings {
  const engines = normalizeEngines(r.engines);
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
    sample: r.sample ?? 1,
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
    extra: r.extra ?? {},
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
        { engine: "perplexity", model: DEFAULT_MODELS.perplexity, samples: DEFAULT_SAMPLES.perplexity },
        { engine: "chat_gpt", model: DEFAULT_MODELS.chat_gpt, samples: DEFAULT_SAMPLES.chat_gpt },
        { engine: "google_ai", model: DEFAULT_MODELS.google_ai, samples: DEFAULT_SAMPLES.google_ai },
      ],
      brandTerms: ["kodus", "kody"],
      competitorTerms: [],
      lastRunOn: null,
      updatedAt: new Date().toISOString(),
    };
  }
  return rowToSettings(data as SettingsRow);
}

export type SettingsPatch = Partial<Pick<AiVisibilitySettings, "weekday" | "brandTerms" | "competitorTerms">> & {
  engines?: Array<Partial<EngineConfig> & { engine: AiEngine }>;
};

export async function updateSettings(client: SupabaseClient, patch: SettingsPatch): Promise<AiVisibilitySettings> {
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (patch.weekday != null) {
    if (!Number.isInteger(patch.weekday) || patch.weekday < 0 || patch.weekday > 6) throw new Error("weekday must be 0..6");
    row.weekday = patch.weekday;
  }
  if (patch.engines) {
    const engines = normalizeEngines(patch.engines);
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
  extra?: RunExtra;
};

function dfsAuthHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN?.trim();
  const password = process.env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) throw new Error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set");
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

type DfsSerpItem = {
  type?: string;
  rank_group?: number;
  domain?: string;
  url?: string;
  title?: string;
  text?: string;
  items?: Array<Record<string, unknown>> | string[] | null;
  references?: Array<{ source?: string; domain?: string; url?: string; title?: string }> | null;
  asynchronous_ai_overview?: boolean;
};

type DfsSerpResponse = {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{ status_code?: number; status_message?: string; cost?: number; result?: Array<{ items?: DfsSerpItem[] | null }> | null }>;
};

/** Location per prompt language: Brazil for Portuguese, United States otherwise. */
function serpLocale(language: string): { location_code: number; language_code: string } {
  return language.toLowerCase().startsWith("pt") ? { location_code: 2076, language_code: "pt" } : { location_code: 2840, language_code: "en" };
}

/**
 * Google AI Overview for a prompt used as a query. The overview loads
 * asynchronously on Google, so the SERP call asks DataForSEO to wait for it.
 * The organic top 10 rides along in `extra`, since the same call pays for
 * both.
 */
export async function askGoogleAiOverview(prompt: string, language: string): Promise<LlmAnswer> {
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method: "POST",
    headers: { Authorization: dfsAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify([{ keyword: prompt.slice(0, 700), ...serpLocale(language), device: "desktop", depth: 10, load_async_ai_overview: true }]),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`DataForSEO SERP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as DfsSerpResponse;
  const task = json.tasks?.[0];
  if (!task || task.status_code !== 20000) {
    throw new Error(`DataForSEO SERP task ${task?.status_code ?? json.status_code}: ${task?.status_message ?? json.status_message ?? "no task"}`);
  }
  const items = task.result?.[0]?.items ?? [];
  const overview = items.find((i) => i.type === "ai_overview");
  const texts: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const addRef = (r: { url?: string; title?: string; source?: string } | undefined) => {
    const url = r?.url?.trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    citations.push({ title: r?.title ?? r?.source ?? null, url });
  };
  if (overview) {
    for (const el of (overview.items ?? []) as Array<Record<string, unknown>>) {
      if (typeof el !== "object" || !el) continue;
      const title = typeof el.title === "string" ? el.title : "";
      const text = typeof el.text === "string" ? el.text : "";
      if (title || text) texts.push([title, text].filter(Boolean).join("\n"));
      for (const r of (el.references as Array<{ url?: string; title?: string; source?: string }> | undefined) ?? []) addRef(r);
      // Nested lists inside an overview element.
      for (const sub of (el.items as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof sub?.text === "string") texts.push(`- ${sub.text}`);
        for (const r of (sub?.references as Array<{ url?: string; title?: string; source?: string }> | undefined) ?? []) addRef(r);
      }
    }
    for (const r of overview.references ?? []) addRef(r);
  }
  const organic = items.filter((i) => i.type === "organic");
  const own = organic.find((i) => /(^|\.)kodus\.io$/i.test(i.domain ?? ""));
  const related = items.find((i) => i.type === "related_searches");
  // Related searches come as plain strings today; an object with a title is
  // the other shape DataForSEO uses for list items.
  const fanOut = Array.isArray(related?.items)
    ? (related!.items as unknown[])
        .map((q) => (typeof q === "string" ? q : typeof (q as { title?: unknown })?.title === "string" ? (q as { title: string }).title : ""))
        .map((q) => q.trim())
        .filter(Boolean)
    : [];
  return {
    modelName: "ai_overview",
    text: texts.join("\n"),
    citations,
    fanOutQueries: fanOut,
    costUsd: Number(task.cost ?? json.cost ?? 0),
    raw: json,
    extra: {
      aiOverview: Boolean(overview) && (texts.length > 0 || citations.length > 0),
      organicRank: own?.rank_group ?? null,
      organicTop: organic.slice(0, 10).map((i) => i.domain ?? "").filter(Boolean),
    },
  };
}

export function isDataForSeoConfigured(): boolean {
  return Boolean(process.env.DATAFORSEO_LOGIN?.trim() && process.env.DATAFORSEO_PASSWORD?.trim());
}

/** Ask one assistant one prompt, web search on, and flatten the answer. */
export async function askAssistant(engine: AiEngine, model: string, prompt: string, language = "en"): Promise<LlmAnswer> {
  if (engine === "google_ai") return askGoogleAiOverview(prompt, language);
  const res = await fetch(`https://api.dataforseo.com/v3/ai_optimization/${engine}/llm_responses/live`, {
    method: "POST",
    headers: {
      Authorization: dfsAuthHeader(),
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

  // Where the brand sits in the answer's ranking. Assistants rank in four
  // shapes: numbered items ("1. ", "1) ", "### 2. Name"), top-level bullets,
  // markdown table rows, and a sentence that enumerates bold names
  // ("include **A**, **B**, **C**"). Numbered items win when present, since
  // bullets under them are usually pros and cons, not entries.
  const lines = text.split(/\r?\n/);
  const numberedRe = /^\s{0,3}(?:#{1,4}\s+)?(?:\*\*)?(\d{1,2})[.)]\s+/;
  const bulletRe = /^(?:[-*•]|\d{1,2}[.)])\s+/;
  const tableRowRe = /^\s*\|/;
  const tableRuleRe = /^\s*\|?\s*:?-{2,}/;
  const hasBrand = (line: string) => brandRe.some((re) => re.test(line));

  // Numbered lines grouped into lists: a new list starts at "1." or when the
  // number stops growing. An answer often has the ranking first and then
  // short "if you want X" lists; the brand's place is read inside its own
  // list, not across all of them.
  const numberedLists: string[][] = [];
  const bullets: string[] = [];
  // Rows per table, so the brand's row number is read inside its own table.
  // A table's header is the row right before its rule line ("|---|"), so
  // rows are held one line before being committed: a rule line drops the
  // held row as the header and opens a new table. Prose between rows, or
  // between two tables, does not confuse the split.
  const tables: string[][] = [];
  let heldRow: string | null = null;
  let prevNumber = 0;
  const commitHeld = () => {
    if (heldRow == null) return;
    if (tables.length === 0) tables.push([]);
    tables[tables.length - 1].push(heldRow);
    heldRow = null;
  };
  for (const line of lines) {
    const m = line.match(numberedRe);
    if (m) {
      const n = Number(m[1]);
      if (n <= prevNumber || n === 1 || numberedLists.length === 0) numberedLists.push([]);
      numberedLists[numberedLists.length - 1].push(line);
      prevNumber = n;
    } else if (bulletRe.test(line)) bullets.push(line);
    if (tableRowRe.test(line)) {
      if (tableRuleRe.test(line)) {
        heldRow = null; // the held row was this table's header
        tables.push([]);
        continue;
      }
      commitHeld();
      heldRow = line;
    } else {
      commitHeld();
    }
  }
  commitHeld();

  let listSize: number | null = null;
  let position: number | null = null;
  const pick = (items: string[], numberedOrder: boolean): boolean => {
    const idx = items.findIndex(hasBrand);
    if (idx < 0) return false;
    listSize = items.length;
    const n = numberedOrder ? Number(items[idx].match(numberedRe)?.[1]) : NaN;
    position = Number.isFinite(n) && n > 0 ? n : idx + 1;
    return true;
  };
  if (mentioned) {
    const inNumbered = numberedLists.some((list) => pick(list, true));
    const inTable = !inNumbered && tables.some((rows) => pick(rows, false));
    if (!inNumbered && !inTable && !(bullets.length && pick(bullets, false))) {
      // Enumerated in prose: order among the bold names of the first sentence
      // whose bold names include the brand.
      const boldOf = (l: string) => [...l.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
      const line = lines.find((l) => boldOf(l).some(hasBrand)) ?? "";
      const bold = boldOf(line);
      const idx = bold.findIndex(hasBrand);
      if (idx >= 0 && bold.length >= 2) {
        position = idx + 1;
        listSize = bold.length;
      }
    }
  }
  if (listSize == null) listSize = numberedLists[0]?.length || tables[0]?.length || bullets.length || null;

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
    listSize: listSize != null && listSize > 0 ? listSize : null,
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
      .select("prompt_id,engine,sample")
      .eq("run_on", runOn)
      .is("error", null)
      .in("prompt_id", prompts.map((p) => p.id));
    for (const r of data ?? []) existing.add(`${r.prompt_id}:${r.engine}:${r.sample ?? 1}`);
  }

  const jobs: Array<{ prompt: AiPrompt; engine: EngineConfig; sample: number }> = [];
  for (const prompt of prompts) {
    for (const engine of engines) {
      for (let sample = 1; sample <= Math.max(1, engine.samples ?? 1); sample++) {
        if (existing.has(`${prompt.id}:${engine.engine}:${sample}`)) {
          summary.skipped += 1;
          continue;
        }
        jobs.push({ prompt, engine, sample });
      }
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
        sample: job.sample,
        model_name: job.engine.model,
      };
      try {
        const answer = await askAssistant(job.engine.engine, job.engine.model, job.prompt.prompt, job.prompt.language);
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
            extra: answer.extra ?? {},
            raw: answer.raw,
          },
          { onConflict: "prompt_id,engine,run_on,sample" },
        );
        if (error) throw new Error(error.message);
        summary.asked += 1;
        summary.costUsd += answer.costUsd;
        if (a.mentioned) summary.mentioned += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.failed += 1;
        summary.errors.push(`${ENGINE_LABEL[job.engine.engine]} #${job.sample} · ${job.prompt.prompt.slice(0, 60)}: ${message}`);
        await client.from("ai_prompt_runs").upsert(
          { ...base, mentioned: false, error: message.slice(0, 500), answer: null },
          { onConflict: "prompt_id,engine,run_on,sample" },
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

/**
 * Recompute mentioned / position / competitors from the stored answer and
 * citations, so a better parser applies to past runs without asking (and
 * paying) again.
 */
export async function reanalyzeRuns(client: SupabaseClient, opts: { runOn?: string } = {}): Promise<{ runs: number; changed: number }> {
  const settings = await getSettings(client);
  const PAGE = 500;
  let runs = 0;
  let changed = 0;
  for (let from = 0; ; from += PAGE) {
    let q = client.from("ai_prompt_runs").select("*").is("error", null).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (opts.runOn) q = q.eq("run_on", opts.runOn);
    const { data, error } = await q;
    if (error) throw new Error(`ai_prompt_runs: ${error.message}`);
    const rows = (data ?? []) as RunRow[];
    runs += rows.length;
    const updates = rows.flatMap((row) => {
      const a = analyzeAnswer(row.answer ?? "", row.citations ?? [], settings.brandTerms, settings.competitorTerms);
      const same =
        a.mentioned === row.mentioned &&
        a.position === row.position &&
        a.listSize === row.list_size &&
        a.brandCited === row.brand_cited &&
        JSON.stringify(a.competitors) === JSON.stringify(row.competitors ?? []) &&
        JSON.stringify(a.citedDomains) === JSON.stringify(row.cited_domains ?? []);
      return same ? [] : [{ id: row.id, patch: { mentioned: a.mentioned, position: a.position, list_size: a.listSize, brand_cited: a.brandCited, competitors: a.competitors, cited_domains: a.citedDomains } }];
    });
    // A few updates in flight at a time: fast enough for a backfill, kind to
    // the pooler.
    for (let i = 0; i < updates.length; i += 5) {
      const results = await Promise.all(
        updates.slice(i, i + 5).map((u) => client.from("ai_prompt_runs").update(u.patch).eq("id", u.id)),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw new Error(`ai_prompt_runs: ${failed.error.message}`);
      changed += results.length;
    }
    if (rows.length < PAGE) break;
  }
  return { runs, changed };
}

// ---------------------------------------------------------------------------
// Summary for the page and the agent
// ---------------------------------------------------------------------------

export type EngineSummary = {
  engine: AiEngine;
  label: string;
  model: string | null;
  /** Prompts asked (with at least one sample without error). */
  prompts: number;
  /** Prompts named in at least one sample. */
  promptsMentioned: number;
  /** Samples without error, and samples naming the brand. */
  samples: number;
  mentioned: number;
  /** mentioned / samples for this run. */
  share: number | null;
  /** Same share over the last ROLLING_RUNS run dates. */
  rollingShare: number | null;
  rollingRuns: number;
  avgPosition: number | null;
  brandCited: number;
  costUsd: number;
  failed: number;
};

/** One prompt on one engine for one run date, all samples folded. */
export type PromptEngineResult = {
  engine: AiEngine;
  samples: number;
  mentioned: number;
  rate: number | null;
  avgPosition: number | null;
  listSize: number | null;
  brandCited: boolean;
  competitors: string[];
  citedDomains: string[];
  extra: RunExtra;
  runs: AiPromptRun[];
  error: string | null;
};

export type PromptSummary = {
  prompt: AiPrompt;
  runs: Partial<Record<AiEngine, PromptEngineResult>>;
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

/** A search the assistants ran before answering: a page that should exist. */
export type SearchSummary = { query: string; runs: number; engines: AiEngine[]; prompts: number };

export type VisibilitySummary = {
  runOn: string | null;
  settings: AiVisibilitySettings;
  engines: EngineSummary[];
  prompts: PromptSummary[];
  domains: DomainSummary[];
  competitors: CompetitorSummary[];
  searches: SearchSummary[];
  totalCostUsd: number;
  /** Share of samples naming the brand, across engines. */
  overallShare: number | null;
  history: Array<{ runOn: string; engine: AiEngine; samples: number; mentioned: number }>;
};

function avg(nums: number[]): number | null {
  return nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10 : null;
}

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
    searches: [],
    totalCostUsd: 0,
    overallShare: null,
    history: [],
  };
  if (!runOn) return empty;

  const [{ data: runRows, error }, { data: histRows }] = await Promise.all([
    client.from("ai_prompt_runs").select("*").eq("run_on", runOn).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(5000),
    client
      .from("ai_prompt_runs")
      .select("run_on,engine,mentioned,error")
      .order("run_on", { ascending: false })
      .order("id", { ascending: true })
      .limit(10000),
  ]);
  if (error) throw new Error(`ai_prompt_runs: ${error.message}`);
  const runs = (runRows ?? []).map((r) => rowToRun(r as RunRow));

  // Fold samples per prompt × engine.
  const byPrompt = new Map<string, Partial<Record<AiEngine, PromptEngineResult>>>();
  for (const r of runs) {
    const m = byPrompt.get(r.promptId) ?? {};
    const cur: PromptEngineResult = m[r.engine] ?? {
      engine: r.engine,
      samples: 0,
      mentioned: 0,
      rate: null,
      avgPosition: null,
      listSize: null,
      brandCited: false,
      competitors: [],
      citedDomains: [],
      extra: {},
      runs: [],
      error: null,
    };
    cur.runs.push(r);
    if (r.error) {
      cur.error = cur.error ?? r.error;
    } else {
      cur.samples += 1;
      if (r.mentioned) cur.mentioned += 1;
      if (r.brandCited) cur.brandCited = true;
      for (const c of r.competitors) if (!cur.competitors.includes(c)) cur.competitors.push(c);
      for (const d of r.citedDomains) if (!cur.citedDomains.includes(d)) cur.citedDomains.push(d);
      if (r.listSize != null) cur.listSize = cur.listSize == null ? r.listSize : Math.max(cur.listSize, r.listSize);
      if (Object.keys(r.extra ?? {}).length) cur.extra = { ...cur.extra, ...r.extra };
    }
    m[r.engine] = cur;
    byPrompt.set(r.promptId, m);
  }
  for (const m of byPrompt.values()) {
    for (const res of Object.values(m)) {
      if (!res) continue;
      res.runs.sort((a, b) => a.sample - b.sample);
      res.rate = res.samples ? res.mentioned / res.samples : null;
      res.avgPosition = avg(res.runs.filter((r) => !r.error && r.mentioned && r.position != null).map((r) => r.position as number));
    }
  }

  const engineAgg = new Map<AiEngine, EngineSummary & { positions: number[]; promptIds: Set<string>; promptIdsMentioned: Set<string> }>();
  const domainAgg = new Map<string, DomainSummary>();
  const compAgg = new Map<string, number>();
  const searchAgg = new Map<string, { query: string; runs: number; engines: Set<AiEngine>; prompts: Set<string> }>();
  let samples = 0;
  let samplesMentioned = 0;
  for (const r of runs) {
    const e =
      engineAgg.get(r.engine) ??
      {
        engine: r.engine,
        label: ENGINE_LABEL[r.engine],
        model: r.modelName,
        prompts: 0,
        promptsMentioned: 0,
        samples: 0,
        mentioned: 0,
        share: null,
        rollingShare: null,
        rollingRuns: 0,
        avgPosition: null,
        brandCited: 0,
        costUsd: 0,
        failed: 0,
        positions: [],
        promptIds: new Set<string>(),
        promptIdsMentioned: new Set<string>(),
      };
    e.costUsd += r.costUsd ?? 0;
    if (r.error) {
      e.failed += 1;
    } else {
      e.samples += 1;
      samples += 1;
      e.promptIds.add(r.promptId);
      if (r.mentioned) {
        e.mentioned += 1;
        samplesMentioned += 1;
        e.promptIdsMentioned.add(r.promptId);
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
      for (const q of r.fanOutQueries) {
        const key = q.trim().toLowerCase();
        if (!key) continue;
        const agg = searchAgg.get(key) ?? { query: q.trim(), runs: 0, engines: new Set<AiEngine>(), prompts: new Set<string>() };
        agg.runs += 1;
        agg.engines.add(r.engine);
        agg.prompts.add(r.promptId);
        searchAgg.set(key, agg);
      }
    }
    engineAgg.set(r.engine, e);
  }

  // History per run date and engine, over samples; the rolling share is the
  // last ROLLING_RUNS dates up to and including this run.
  const histAgg = new Map<string, { runOn: string; engine: AiEngine; samples: number; mentioned: number }>();
  for (const h of histRows ?? []) {
    if (h.error || !isEngine(h.engine)) continue;
    const key = `${h.run_on}:${h.engine}`;
    const agg = histAgg.get(key) ?? { runOn: String(h.run_on), engine: h.engine, samples: 0, mentioned: 0 };
    agg.samples += 1;
    if (h.mentioned) agg.mentioned += 1;
    histAgg.set(key, agg);
  }
  const history = [...histAgg.values()].sort((a, b) => a.runOn.localeCompare(b.runOn) || a.engine.localeCompare(b.engine));
  const rollingDates = [...new Set(history.map((h) => h.runOn))].filter((d) => d <= runOn!).sort().slice(-ROLLING_RUNS);

  const engines: EngineSummary[] = [...engineAgg.values()].map(({ positions, promptIds, promptIdsMentioned, ...e }) => {
    const window = history.filter((h) => h.engine === e.engine && rollingDates.includes(h.runOn));
    const wSamples = window.reduce((s, h) => s + h.samples, 0);
    const wMentioned = window.reduce((s, h) => s + h.mentioned, 0);
    return {
      ...e,
      prompts: promptIds.size,
      promptsMentioned: promptIdsMentioned.size,
      share: e.samples ? e.mentioned / e.samples : null,
      rollingShare: wSamples ? wMentioned / wSamples : null,
      rollingRuns: window.length ? new Set(window.map((h) => h.runOn)).size : 0,
      avgPosition: avg(positions),
      costUsd: Math.round(e.costUsd * 1e4) / 1e4,
    };
  });
  engines.sort((a, b) => AI_ENGINES.indexOf(a.engine) - AI_ENGINES.indexOf(b.engine));

  const ownDomains = new Set(["kodus.io", "trykodus.com"]);
  const domains = [...domainAgg.values()]
    .filter((d) => !ownDomains.has(d.domain))
    .sort((a, b) => b.runsWithoutBrand - a.runsWithoutBrand || b.citations - a.citations)
    .slice(0, 40);

  const competitors = [...compAgg.entries()].map(([name, n]) => ({ name, runs: n })).sort((a, b) => b.runs - a.runs);

  const searches: SearchSummary[] = [...searchAgg.values()]
    .map((sq) => ({ query: sq.query, runs: sq.runs, engines: [...sq.engines], prompts: sq.prompts.size }))
    .sort((a, b) => b.runs - a.runs || a.query.localeCompare(b.query))
    .slice(0, 60);

  return {
    runOn,
    settings,
    engines,
    prompts: prompts.map((p) => ({ prompt: p, runs: byPrompt.get(p.id) ?? {} })),
    domains,
    competitors,
    searches,
    totalCostUsd: Math.round(runs.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 1e4) / 1e4,
    overallShare: samples ? samplesMentioned / samples : null,
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
