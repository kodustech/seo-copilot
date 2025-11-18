import type {
  ArticlePost,
  KeywordSuggestion,
  KeywordTaskTicket,
  TitleIdea,
} from "@/lib/types";

const KEYWORDS_ENDPOINT =
  process.env.N8N_KEYWORDS_ENDPOINT ??
  "https://n8n.kodus.io/webhook/generate-keywords";
const KEYWORDS_STATUS_ENDPOINT =
  process.env.N8N_KEYWORDS_STATUS_ENDPOINT ??
  "https://n8n.kodus.io/webhook/get-task";
const KEYWORDS_HISTORY_ENDPOINT =
  process.env.N8N_KEYWORDS_HISTORY_ENDPOINT ??
  "https://n8n.kodus.io/webhook/keywords-history";
const TITLES_ENDPOINT =
  process.env.N8N_TITLES_ENDPOINT ??
  "https://n8n.kodus.io/webhook/generate-titles";
const POSTS_ENDPOINT =
  process.env.N8N_POST_ENDPOINT ??
  "https://n8n.kodus.io/webhook/generate-post";
const ARTICLES_STATUS_ENDPOINT =
  process.env.N8N_ARTICLES_ENDPOINT ??
  "https://n8n.kodus.io/webhook/get-articles";

const n8nBearerToken = process.env.N8N_BEARER_TOKEN?.trim();
const jsonHeaders: Record<string, string> = {
  "Content-Type": "application/json",
};

if (n8nBearerToken) {
  jsonHeaders.Authorization = `Bearer ${n8nBearerToken}`;
}

export async function enqueueKeywordTask({
  idea,
  limit,
  locationCode,
  language,
}: {
  idea?: string | null;
  limit?: number | null;
  locationCode?: number | null;
  language?: string | null;
}): Promise<{ taskId: number; status?: string | null }> {
  const payload: Record<string, unknown> = {};
  if (idea?.trim()) {
    payload.example = idea.trim();
  }
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    payload.limit = Math.min(50, Math.max(5, Math.round(limit)));
  }
  if (typeof locationCode === "number" && Number.isFinite(locationCode)) {
    payload.location_code = locationCode;
  }
  if (typeof language === "string" && language.trim().length > 0) {
    payload.language = language.trim();
  }
  const response = await fetch(KEYWORDS_ENDPOINT, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Erro ao enfileirar geração (${response.status}). ${text || "Tente novamente."}`,
    );
  }

  const body = await safeReadJson(response);
  const ticket = parseTaskTicket(body);

  if (!ticket) {
    throw new Error("Não recebemos o identificador da task.");
  }

  return { taskId: ticket.id, status: ticket.status };
}

export async function fetchKeywordTaskResult(taskId: number): Promise<{
  ready: boolean;
  keywords?: KeywordSuggestion[];
}> {
  if (!Number.isFinite(taskId)) {
    throw new Error("Task inválida.");
  }

  const statusUrl = new URL(KEYWORDS_STATUS_ENDPOINT);
  statusUrl.searchParams.set("task_id", String(taskId));

  const response = await fetch(statusUrl.toString(), {
    method: "GET",
    headers: jsonHeaders,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Erro ao checar task (${response.status}). ${text || "Tente novamente."}`,
    );
  }

  const body = await safeReadJson(response);

  if (Array.isArray(body) && body.length === 0) {
    return { ready: false };
  }

  const keywords = normalizeKeywords(body, null);

  if (!keywords.length) {
    return { ready: false };
  }

  return { ready: true, keywords };
}

export async function fetchKeywordsHistory(): Promise<KeywordSuggestion[]> {
  const response = await fetch(KEYWORDS_HISTORY_ENDPOINT, {
    method: "GET",
    headers: jsonHeaders,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Erro ao buscar histórico (${response.status}). ${text || "Tente novamente."}`,
    );
  }

  const body = await safeReadJson(response);
  const keywords = normalizeKeywords(body, null);
  return keywords;
}

type TitleKeywordPayload = {
  keyword: string;
  instruction?: string;
};

export async function fetchTitlesFromCopilot({
  keywords,
}: {
  keywords: TitleKeywordPayload[];
}): Promise<{ titles: TitleIdea[] }> {
  if (!keywords.length) {
    throw new Error("Escolha pelo menos uma keyword para gerar títulos.");
  }

  const response = await fetch(TITLES_ENDPOINT, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      keywords,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Erro ao gerar títulos (${response.status}). ${text || "Tente novamente."}`,
    );
  }

  const body = await safeReadJson(response);
  const titles = normalizeTitles(
    body,
    keywords.map((item) => item.keyword),
  );

  if (!titles.length) {
    throw new Error("Não recebemos nenhuma sugestão de título.");
  }

  return { titles };
}

type ArticleTaskPayload = {
  title: string;
  keyword: string;
  keywordId?: string;
  useResearch: boolean;
  researchInstructions?: string;
  customInstructions?: string;
  categories?: number[];
};

export async function enqueueArticleTask(
  payload: ArticleTaskPayload,
): Promise<{ taskId: number; status?: string | null }> {
  if (!payload.title.trim()) {
    throw new Error("Escolha um título para o artigo.");
  }
  if (!payload.keyword.trim()) {
    throw new Error("Escolha uma keyword principal para o artigo.");
  }

  const response = await fetch(POSTS_ENDPOINT, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      title: payload.title,
      keyword: payload.keyword,
      keyword_id: payload.keywordId,
      useResearch: payload.useResearch,
      researchInstructions: payload.researchInstructions?.trim() || undefined,
      customInstructions: payload.customInstructions?.trim() || undefined,
      categories:
        payload.categories && payload.categories.length > 0
          ? payload.categories.map((value) => Number(value))
          : undefined,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Erro ao enfileirar artigo (${response.status}). ${text || "Tente novamente."}`,
    );
  }

  const body = await safeReadJson(response);
  const ticket = parseTaskTicket(body);

  if (!ticket) {
    throw new Error("Não recebemos o identificador da task de artigo.");
  }

  return { taskId: ticket.id, status: ticket.status };
}

export async function fetchArticleTaskResult(taskId: number): Promise<{
  ready: boolean;
  articles?: ArticlePost[];
}> {
  if (!Number.isFinite(taskId)) {
    throw new Error("Task inválida.");
  }

  const statusUrl = new URL(ARTICLES_STATUS_ENDPOINT);
  statusUrl.searchParams.set("task_id", String(taskId));

  const response = await fetch(statusUrl.toString(), {
    method: "GET",
    headers: jsonHeaders,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Erro ao checar artigo (${response.status}). ${text || "Tente novamente."}`,
    );
  }

  const body = await safeReadJson(response);
  if (!Array.isArray(body) || body.length === 0) {
    return { ready: false };
  }

  const articles = body
    .map((item) => normalizeArticleResult(item))
    .filter((item): item is ArticlePost => Boolean(item));
  if (!articles.length) {
    return { ready: false };
  }

  return { ready: true, articles };
}

async function safeReadJson(response: Response) {
  try {
    return await response.clone().json();
  } catch {
    return {};
  }
}

async function safeReadText(response: Response) {
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

function normalizeKeywords(
  payload: unknown,
  idea: string | null,
): KeywordSuggestion[] {
  const rawList = pickArray(payload, ["keywords", "data", "results"]);

  return rawList
    .map((item) => normalizeKeywordItem(item, idea))
    .filter((item): item is KeywordSuggestion => Boolean(item));
}

function normalizeKeywordItem(
  item: unknown,
  idea: string | null,
): KeywordSuggestion | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const phrase = String(
    record.keyword ??
      record.keywords ??
      record.phrase ??
      record.term ??
      record.name ??
      "",
  ).trim();

  if (!phrase) {
    return null;
  }

  const { score, label } = parseDifficulty(
    record.difficulty ??
      record.keywordDifficulty ??
      record.kd ??
      record.competition,
  );

  const derivedIdea =
    typeof record.idea === "string" && record.idea.trim().length > 0
      ? record.idea.trim()
      : idea;

  return {
    id: (record.id as string) ?? crypto.randomUUID(),
    phrase,
    volume: toNumber(
      record.volume ?? record.searchVolume ?? record.search_volume,
    ),
    cpc: toNumber(record.cpc ?? record.cost ?? record.costPerClick),
    difficulty: score,
    difficultyLabel: label,
    idea: derivedIdea,
    locationCode: toNumber(record.location_code ?? record.locationCode),
    language:
      typeof record.language === "string"
        ? record.language.trim() || undefined
        : undefined,
  };
}

function normalizeTitles(payload: unknown, keywords: string[]): TitleIdea[] {
  const rawList = pickArray(payload, ["titles", "data", "results"]);

  return rawList
    .map((item) => normalizeTitleItem(item, keywords))
    .filter((item): item is TitleIdea => Boolean(item));
}

function normalizeTitleItem(
  item: unknown,
  fallbackKeywords: string[],
): TitleIdea | null {
  if (!item) {
    return null;
  }

  if (typeof item === "string") {
    const clean = item.trim();
    return clean
      ? {
          id: crypto.randomUUID(),
          text: clean,
          keywords: fallbackKeywords,
        }
      : null;
  }

  if (typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const text = String(
    record.title ?? record.text ?? record.headline ?? "",
  ).trim();

  if (!text) {
    return null;
  }

  const keywords =
    Array.isArray(record.keywords) && record.keywords.length > 0
      ? record.keywords.map((value) => String(value))
      : fallbackKeywords;

  return {
    id: (record.id as string) ?? crypto.randomUUID(),
    text,
    keywords,
    mood: record.tone ? String(record.tone) : undefined,
  };
}

function normalizeArticleResult(item: unknown): ArticlePost | null {
  if (!item) {
    return null;
  }

  if (typeof item === "string") {
    const content = item.trim();
    return content
      ? {
          id: crypto.randomUUID(),
          title: content.slice(0, 64) || "Artigo",
          content,
        }
      : null;
  }

  if (typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const content = normalizeArticleContent(
    record.content ?? record.article ?? record.text ?? record.body,
  );
  const url =
    typeof record.url === "string" && record.url.trim().length > 0
      ? record.url.trim()
      : undefined;

  if (!url && !content) {
    return null;
  }

  const title =
    typeof record.title === "string" && record.title.trim().length > 0
      ? record.title.trim()
      : undefined;
  return {
    id: (record.id as string) ?? crypto.randomUUID(),
    title,
    content,
    url,
    keyword: typeof record.keyword === "string" ? record.keyword : undefined,
    keywordId: typeof record.keyword_id === "string" ? record.keyword_id : undefined,
    categories:
      typeof record.categories === "string" ? record.categories : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
  };
}

function normalizeArticleContent(payload: unknown): string {
  if (!payload) {
    return "";
  }

  if (typeof payload === "string") {
    return payload.trim();
  }

  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const text =
      record.content ??
      record.article ??
      record.data ??
      record.result ??
      record.text;

    if (typeof text === "string") {
      return text.trim();
    }
  }

  return "";
}

function pickArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (record.output) {
      const nested = pickArray(record.output, keys);
      if (nested.length) {
        return nested;
      }
    }

    for (const key of keys) {
      const potential = record[key];
      if (Array.isArray(potential)) {
        return potential;
      }
    }
  }

  return [];
}

function parseTaskTicket(payload: unknown): KeywordTaskTicket | null {
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const ticket = parseTaskTicketRecord(entry);
      if (ticket) {
        return ticket;
      }
    }
    return null;
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.results)) {
      return parseTaskTicket(record.results[0]);
    }
    if (Array.isArray(record.data)) {
      return parseTaskTicket(record.data[0]);
    }
    return parseTaskTicketRecord(record);
  }

  return null;
}

function parseTaskTicketRecord(value: unknown): KeywordTaskTicket | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const taskId = Number(record.task_id ?? record.id);
  if (!Number.isFinite(taskId)) {
    return null;
  }
  return {
    id: taskId,
    status:
      typeof record.status === "string" && record.status.length > 0
        ? record.status
        : null,
  };
}

const difficultyTextMap: Record<
  string,
  { score: number; label: string }
> = {
  VERY_LOW: { score: 15, label: "Muito baixa" },
  LOW: { score: 30, label: "Baixa" },
  MEDIUM: { score: 55, label: "Média" },
  HIGH: { score: 75, label: "Alta" },
  VERY_HIGH: { score: 90, label: "Muito alta" },
  EASY: { score: 25, label: "Fácil" },
  HARD: { score: 85, label: "Difícil" },
};

function parseDifficulty(
  value: unknown,
): { score: number; label?: string | null } {
  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean) {
      return { score: 0, label: null };
    }

    const numeric = Number(clean);
    if (Number.isFinite(numeric)) {
      return { score: numeric, label: difficultyLabelFromScore(numeric) };
    }

    const lookup = clean.toUpperCase().replace(/[\s-]+/g, "_");
    if (difficultyTextMap[lookup]) {
      return difficultyTextMap[lookup];
    }

    return { score: 0, label: titleCase(clean) };
  }

  const numeric = toNumber(value);
  return { score: numeric, label: difficultyLabelFromScore(numeric) };
}

function difficultyLabelFromScore(score: number) {
  if (!Number.isFinite(score) || score <= 0) {
    return null;
  }

  if (score < 20) return "Muito baixa";
  if (score < 40) return "Baixa";
  if (score < 60) return "Média";
  if (score < 80) return "Alta";
  return "Muito alta";
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function toNumber(value: unknown): number {
  const parsed = Number(
    typeof value === "string" ? value.replace(/[^\d.,-]/g, "").replace(",", ".") : value,
  );
  return Number.isFinite(parsed) ? parsed : 0;
}
