import type {
  ArticlePost,
  KeywordSuggestion,
  KeywordTaskTicket,
  SocialPostVariation,
  TitleIdea,
} from "@/lib/types";
import type { VoicePolicyPayload } from "@/lib/voice-policy";

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
const SOCIAL_ENDPOINT =
  process.env.N8N_SOCIAL_ENDPOINT ??
  "https://n8n.kodus.io/webhook/social";
const ARTICLES_STATUS_ENDPOINT =
  process.env.N8N_ARTICLES_ENDPOINT ??
  "https://n8n.kodus.io/webhook/get-articles";
const POST_BRIDGE_API_URL =
  process.env.POST_BRIDGE_API_URL?.replace(/\/$/, "") ??
  "https://api.post-bridge.com";
const POST_BRIDGE_API_KEY = process.env.POST_BRIDGE_API_KEY?.trim();
const GOOGLE_GENERATIVE_AI_API_KEY =
  process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL?.trim() ?? "gemini-2.5-flash-image-preview";
const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY?.trim();
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX?.trim();
const IMGFLIP_API_URL = "https://api.imgflip.com";
const IMGFLIP_USERNAME = process.env.IMGFLIP_USERNAME?.trim();
const IMGFLIP_PASSWORD = process.env.IMGFLIP_PASSWORD?.trim();

const n8nBearerToken = process.env.N8N_BEARER_TOKEN?.trim();
const jsonHeaders: Record<string, string> = {
  "Content-Type": "application/json",
};

if (n8nBearerToken) {
  jsonHeaders.Authorization = `Bearer ${n8nBearerToken}`;
}

type StreamingJsonRequestInit = RequestInit & { duplex: "half" };

function buildStreamingJsonBody(payload: unknown): ReadableStream<Uint8Array> {
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  let sent = false;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }

      controller.enqueue(encodedPayload);
      sent = true;
    },
  });
}

function n8nPostInit(payload: unknown): StreamingJsonRequestInit {
  return {
    method: "POST",
    headers: jsonHeaders,
    body: buildStreamingJsonBody(payload),
    cache: "no-store",
    duplex: "half",
  };
}

export async function enqueueKeywordTask({
  idea,
  limit,
  locationCode,
  language,
  voicePolicy,
}: {
  idea?: string | null;
  limit?: number | null;
  locationCode?: number | null;
  language?: string | null;
  voicePolicy?: VoicePolicyPayload | null;
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
  if (voicePolicy) {
    payload.voicePolicy = voicePolicy;
  }
  const response = await fetch(KEYWORDS_ENDPOINT, n8nPostInit(payload));

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error queueing generation (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  const ticket = parseTaskTicket(body);

  if (!ticket) {
    throw new Error("We did not receive the task identifier.");
  }

  return { taskId: ticket.id, status: ticket.status };
}

export async function fetchKeywordTaskResult(taskId: number): Promise<{
  ready: boolean;
  keywords?: KeywordSuggestion[];
}> {
  if (!Number.isFinite(taskId)) {
    throw new Error("Invalid task.");
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
      `Error checking task (${response.status}). ${text || "Try again."}`,
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
      `Error fetching history (${response.status}). ${text || "Try again."}`,
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
  voicePolicy,
}: {
  keywords: TitleKeywordPayload[];
  voicePolicy?: VoicePolicyPayload | null;
}): Promise<{ titles: TitleIdea[] }> {
  if (!keywords.length) {
    throw new Error("Choose at least one keyword to generate titles.");
  }

  const payload: Record<string, unknown> = {
    keywords,
  };
  if (voicePolicy) {
    payload.voicePolicy = voicePolicy;
  }

  const response = await fetch(TITLES_ENDPOINT, n8nPostInit(payload));

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error generating titles (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  const titles = normalizeTitles(
    body,
    keywords.map((item) => item.keyword),
  );

  if (!titles.length) {
    throw new Error("We did not receive any title suggestions.");
  }

  return { titles };
}

type ArticleTaskPayload = {
  title: string;
  keyword: string;
  keywordId?: string;
  useResearch: boolean;
  publishMode?: "draft" | "publish";
  researchInstructions?: string;
  customInstructions?: string;
  categories?: number[];
  voicePolicy?: VoicePolicyPayload | null;
};

export async function enqueueArticleTask(
  payload: ArticleTaskPayload,
): Promise<{ taskId: number; status?: string | null }> {
  if (!payload.title.trim()) {
    throw new Error("Choose a title for the article.");
  }
  if (!payload.keyword.trim()) {
    throw new Error("Choose a main keyword for the article.");
  }

  const response = await fetch(
    POSTS_ENDPOINT,
    n8nPostInit({
      title: payload.title,
      keyword: payload.keyword,
      keyword_id: payload.keywordId,
      useResearch: payload.useResearch,
      publishMode: payload.publishMode,
      autoPublish: payload.publishMode === "publish",
      researchInstructions: payload.researchInstructions?.trim() || undefined,
      customInstructions: payload.customInstructions?.trim() || undefined,
      categories:
        payload.categories && payload.categories.length > 0
          ? payload.categories.map((value) => Number(value))
          : undefined,
      voicePolicy: payload.voicePolicy ?? undefined,
    }),
  );

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error queueing article (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  const ticket = parseTaskTicket(body);

  if (!ticket) {
    throw new Error("We did not receive the article task identifier.");
  }

  return { taskId: ticket.id, status: ticket.status };
}

export async function fetchArticleTaskResult(taskId: number): Promise<{
  ready: boolean;
  articles?: ArticlePost[];
}> {
  if (!Number.isFinite(taskId)) {
    throw new Error("Invalid task.");
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
      `Error checking article (${response.status}). ${text || "Try again."}`,
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

export type SocialPlatformConfigInput = Partial<{
  platform: string;
  maxLength: number;
  hashtagsPolicy: string;
  linksPolicy: string;
  ctaStyle: string;
  numVariations: number;
}>;

type SocialPlatformConfigPayload = {
  platform: string;
  maxLength?: number;
  hashtagsPolicy?: string;
  linksPolicy?: string;
  ctaStyle?: string;
  numVariations?: number;
};

export type SocialAccount = {
  id: number;
  platform: string;
  username: string;
};

export type SocialImageSearchResult = {
  id: string;
  url: string;
  thumbnailUrl: string;
  title: string;
  source: string;
};

export type MemeGenerationResult = {
  imageUrl: string;
  pageUrl: string;
  templateId: string;
  templateName: string;
};

export type ScheduledSocialPost = {
  id: string;
  status: string | null;
  scheduledAt: string | null;
};

export type ScheduledSocialCalendarPost = {
  id: string;
  caption: string;
  status: string | null;
  scheduledAt: string | null;
  socialAccountIds: number[];
};

export type SocialContentSource = "blog" | "changelog" | "manual";
export type SocialGenerationMode = "content_marketing" | "build_in_public";

export async function generateSocialContent({
  baseContent,
  instructions,
  language,
  tone,
  variationStrategy,
  platformConfigs,
  contentSource,
  generationMode,
  voicePolicy,
}: {
  baseContent: string;
  instructions?: string;
  language: string;
  tone?: string;
  variationStrategy?: string;
  platformConfigs?: SocialPlatformConfigInput[];
  contentSource?: SocialContentSource;
  generationMode?: SocialGenerationMode;
  voicePolicy?: VoicePolicyPayload | null;
}): Promise<SocialPostVariation[]> {
  if (!baseContent.trim()) {
    throw new Error("Provide base content to generate posts.");
  }

  const normalizedConfigs = sanitizePlatformConfigs(platformConfigs);
  if (!normalizedConfigs.length) {
    throw new Error("Define at least one platform to generate posts.");
  }

  const resolvedGenerationMode =
    generationMode ??
    (contentSource === "changelog" ? "build_in_public" : "content_marketing");

  const payload: Record<string, unknown> = {
    baseContent: baseContent.trim(),
    language,
    platformConfigs: normalizedConfigs,
    generationMode: resolvedGenerationMode,
  };

  if (instructions?.trim()) payload.instructions = instructions.trim();
  if (tone?.trim()) payload.tone = tone.trim();
  if (variationStrategy?.trim()) payload.variationStrategy = variationStrategy.trim();
  if (contentSource) payload.contentSource = contentSource;
  if (voicePolicy) payload.voicePolicy = voicePolicy;

  const response = await fetch(SOCIAL_ENDPOINT, n8nPostInit(payload));

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error generating posts (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  const variations = normalizeSocialPosts(body);

  if (!variations.length) {
    throw new Error("We did not receive posts from the copilot.");
  }

  return variations;
}

export async function fetchSocialAccounts({
  userEmail,
}: {
  userEmail?: string;
} = {}): Promise<SocialAccount[]> {
  // Keep argument for compatibility with existing call sites/tools.
  void userEmail;

  const response = await fetch(`${POST_BRIDGE_API_URL}/v1/social-accounts?limit=100`, {
    method: "GET",
    headers: postBridgeHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error fetching social accounts (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  return normalizeSocialAccounts(body);
}

type ImgflipTemplate = {
  id: string;
  name: string;
  url: string;
};

export async function generateImgflipMeme({
  templateQuery,
  topText,
  bottomText,
}: {
  templateQuery?: string;
  topText?: string;
  bottomText?: string;
}): Promise<MemeGenerationResult> {
  const textTop = (topText || "").trim();
  const textBottom = (bottomText || "").trim();
  if (!textTop && !textBottom) {
    throw new Error("Provide at least one text line for the meme.");
  }

  if (!IMGFLIP_USERNAME || !IMGFLIP_PASSWORD) {
    throw new Error(
      "Missing IMGFLIP_USERNAME or IMGFLIP_PASSWORD. Configure both to enable Meme mode.",
    );
  }

  const templatesResponse = await fetch(`${IMGFLIP_API_URL}/get_memes`, {
    method: "GET",
    cache: "no-store",
  });
  if (!templatesResponse.ok) {
    const text = await safeReadText(templatesResponse);
    throw new Error(
      `Error loading meme templates (${templatesResponse.status}). ${
        text || "Try again."
      }`,
    );
  }

  const templatesPayload = await safeReadJson(templatesResponse);
  const templates = normalizeImgflipTemplates(templatesPayload);
  if (!templates.length) {
    throw new Error("Imgflip returned no meme templates.");
  }

  const selectedTemplate = pickImgflipTemplate(templates, templateQuery);
  if (!selectedTemplate) {
    throw new Error("Could not match any meme template.");
  }

  const body = new URLSearchParams();
  body.set("username", IMGFLIP_USERNAME);
  body.set("password", IMGFLIP_PASSWORD);
  body.set("template_id", selectedTemplate.id);
  body.set("text0", textTop || " ");
  body.set("text1", textBottom || " ");

  const captionResponse = await fetch(`${IMGFLIP_API_URL}/caption_image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    cache: "no-store",
    body: body.toString(),
  });

  if (!captionResponse.ok) {
    const text = await safeReadText(captionResponse);
    throw new Error(
      `Error generating meme (${captionResponse.status}). ${text || "Try again."}`,
    );
  }

  const captionPayload = await safeReadJson(captionResponse);
  const root = asRecord(captionPayload);
  const success = root?.success === true;
  if (!success) {
    const errorMessage =
      typeof root?.error_message === "string" && root.error_message.trim().length > 0
        ? root.error_message.trim()
        : "Imgflip rejected meme generation.";
    throw new Error(errorMessage);
  }

  const data = asRecord(root?.data);
  const imageUrl =
    typeof data?.url === "string" && data.url.trim().length > 0
      ? data.url.trim()
      : "";
  const pageUrl =
    typeof data?.page_url === "string" && data.page_url.trim().length > 0
      ? data.page_url.trim()
      : "";

  if (!imageUrl) {
    throw new Error("Imgflip did not return a generated image URL.");
  }

  return {
    imageUrl,
    pageUrl,
    templateId: selectedTemplate.id,
    templateName: selectedTemplate.name,
  };
}

function normalizeImgflipTemplates(payload: unknown): ImgflipTemplate[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const memes = Array.isArray(data?.memes) ? data?.memes : [];

  return memes
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;

      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const url =
        typeof record.url === "string" && /^https?:\/\//i.test(record.url)
          ? record.url.trim()
          : "";

      if (!id || !name || !url) {
        return null;
      }

      return { id, name, url } as ImgflipTemplate;
    })
    .filter((item): item is ImgflipTemplate => Boolean(item));
}

function pickImgflipTemplate(
  templates: ImgflipTemplate[],
  query?: string,
): ImgflipTemplate | null {
  if (!templates.length) return null;
  const cleaned = (query || "").trim().toLowerCase();

  if (!cleaned) {
    return templates[0];
  }

  const tokens = cleaned.split(/\s+/g).filter(Boolean);
  const scored = templates
    .map((template) => {
      const name = template.name.toLowerCase();
      let score = 0;
      if (name.includes(cleaned)) {
        score += cleaned.length + 20;
      }
      for (const token of tokens) {
        if (name.includes(token)) {
          score += token.length + 2;
        }
      }
      return { template, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored[0] && scored[0].score > 0) {
    return scored[0].template;
  }

  return templates[0];
}

export async function searchGoogleImages({
  query,
  limit = 8,
}: {
  query: string;
  limit?: number;
}): Promise<SocialImageSearchResult[]> {
  const cleanedQuery = query.trim();
  if (!cleanedQuery) {
    throw new Error("Provide a query to search images.");
  }

  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) {
    throw new Error(
      "Missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX. Configure both to enable Google image search.",
    );
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_CSE_API_KEY);
  url.searchParams.set("cx", GOOGLE_CSE_CX);
  url.searchParams.set("q", cleanedQuery);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("safe", "active");
  url.searchParams.set("num", String(Math.max(1, Math.min(10, Math.round(limit)))));

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error searching images (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  const root = asRecord(body);
  const items = Array.isArray(root?.items) ? root.items : [];

  const results = items
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;

      const url =
        typeof record.link === "string" && /^https?:\/\//i.test(record.link)
          ? record.link.trim()
          : "";
      if (!url) return null;

      const image = asRecord(record.image);
      const thumbnail =
        typeof image?.thumbnailLink === "string" && image.thumbnailLink.trim().length > 0
          ? image.thumbnailLink.trim()
          : url;
      const title =
        typeof record.title === "string" && record.title.trim().length > 0
          ? record.title.trim()
          : "Google image result";
      const source =
        typeof record.displayLink === "string" && record.displayLink.trim().length > 0
          ? record.displayLink.trim()
          : "google.com";

      return {
        id: typeof record.cacheId === "string" ? record.cacheId : crypto.randomUUID(),
        url,
        thumbnailUrl: thumbnail,
        title,
        source,
      } satisfies SocialImageSearchResult;
    })
    .filter((item): item is SocialImageSearchResult => Boolean(item));

  return results;
}

export async function generateGeminiImage({
  prompt,
}: {
  prompt: string;
}): Promise<{ dataUri: string; mimeType: string }> {
  const cleanedPrompt = prompt.trim();
  if (!cleanedPrompt) {
    throw new Error("Provide a prompt to generate an image.");
  }

  if (!GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error(
      "Missing GOOGLE_GENERATIVE_AI_API_KEY. Configure it to enable Gemini image generation.",
    );
  }

  const endpoint = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_IMAGE_MODEL,
    )}:generateContent`,
  );
  endpoint.searchParams.set("key", GOOGLE_GENERATIVE_AI_API_KEY);

  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: cleanedPrompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error generating image (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  const inline = findInlineImagePart(body);
  if (!inline) {
    throw new Error(
      "Gemini returned no image bytes. Check model/permissions for image generation.",
    );
  }

  return {
    dataUri: `data:${inline.mimeType};base64,${inline.data}`,
    mimeType: inline.mimeType,
  };
}

export async function scheduleSocialPost({
  caption,
  scheduledAt,
  socialAccountIds,
  userEmail,
}: {
  caption: string;
  scheduledAt: string;
  socialAccountIds: number[];
  userEmail?: string;
}): Promise<ScheduledSocialPost> {
  const trimmedCaption = caption.trim();
  if (!trimmedCaption) {
    throw new Error("Provide a caption before scheduling.");
  }

  const normalizedIds = Array.from(
    new Set(
      socialAccountIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );

  if (!normalizedIds.length) {
    throw new Error("Choose at least one social account.");
  }

  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) {
    throw new Error("Invalid schedule date.");
  }

  const payload: Record<string, unknown> = {
    caption: trimmedCaption,
    scheduled_at: scheduledDate.toISOString(),
    social_accounts: normalizedIds,
  };

  // Keep argument for compatibility with existing call sites/tools.
  void userEmail;

  const response = await fetch(`${POST_BRIDGE_API_URL}/v1/posts`, {
    method: "POST",
    headers: postBridgeHeaders(),
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Error scheduling social post (${response.status}). ${text || "Try again."}`,
    );
  }

  const body = await safeReadJson(response);
  const scheduledPost = normalizeScheduledSocialPost(body);
  if (!scheduledPost) {
    throw new Error("Invalid response while scheduling social post.");
  }

  return scheduledPost;
}

export async function fetchScheduledSocialPosts(): Promise<
  ScheduledSocialCalendarPost[]
> {
  const posts: ScheduledSocialCalendarPost[] = [];
  let nextUrl: URL | null = new URL(`${POST_BRIDGE_API_URL}/v1/posts`);
  nextUrl.searchParams.set("status", "scheduled");
  nextUrl.searchParams.set("limit", "100");

  let pages = 0;
  while (nextUrl && pages < 8) {
    pages += 1;

    const response = await fetch(nextUrl.toString(), {
      method: "GET",
      headers: postBridgeHeaders(),
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(
        `Error fetching scheduled social posts (${response.status}). ${
          text || "Try again."
        }`,
      );
    }

    const body = await safeReadJson(response);
    posts.push(...normalizeScheduledSocialPosts(body));

    const root = asRecord(body);
    const meta = asRecord(root?.meta);
    const nextCandidate =
      typeof meta?.next === "string" ? meta.next.trim() : "";
    const next =
      nextCandidate && nextCandidate.toLowerCase() !== "null"
        ? nextCandidate
        : null;

    if (!next) {
      nextUrl = null;
      continue;
    }

    try {
      nextUrl = new URL(next, POST_BRIDGE_API_URL);
    } catch {
      nextUrl = null;
    }
  }

  const unique = new Map<string, ScheduledSocialCalendarPost>();
  for (const post of posts) {
    unique.set(post.id, post);
  }

  return Array.from(unique.values());
}

type InlineImagePart = {
  data: string;
  mimeType: string;
};

function findInlineImagePart(payload: unknown): InlineImagePart | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = findInlineImagePart(entry);
      if (found) return found;
    }
    return null;
  }

  const record = payload as Record<string, unknown>;
  const inlineData = asRecord(record.inlineData ?? record.inline_data);
  if (inlineData) {
    const data =
      typeof inlineData.data === "string" ? inlineData.data.trim() : "";
    const mimeTypeCandidate = inlineData.mimeType ?? inlineData.mime_type;
    const mimeType =
      typeof mimeTypeCandidate === "string"
        ? mimeTypeCandidate.trim()
        : "";

    if (data && mimeType.startsWith("image/")) {
      return { data, mimeType };
    }
  }

  for (const value of Object.values(record)) {
    const found = findInlineImagePart(value);
    if (found) return found;
  }

  return null;
}

function normalizePublicUrl(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

type NormalizedDataUri = {
  dataUri: string;
  mimeType: string;
  base64: string;
  bytes: ArrayBuffer;
  sizeBytes: number;
};

function normalizeDataUri(value: string | undefined): NormalizedDataUri | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=\n\r]+)$/);
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  if (!mimeType.startsWith("image/")) return null;

  const base64 = match[2].replace(/\s+/g, "");
  if (!base64) return null;

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) return null;
  const bytes = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );

  return {
    dataUri: trimmed,
    mimeType,
    base64,
    bytes,
    sizeBytes: buffer.byteLength,
  };
}

function fileExtensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

async function uploadGeneratedImageToPostBridge(
  image: NormalizedDataUri,
): Promise<string> {
  const extension = fileExtensionForMimeType(image.mimeType);
  const fileName = `social-image-${Date.now()}.${extension}`;

  const createUploadResponse = await fetch(
    `${POST_BRIDGE_API_URL}/v1/media/create-upload-url`,
    {
      method: "POST",
      headers: postBridgeHeaders(),
      cache: "no-store",
      body: JSON.stringify({
        name: fileName,
        mime_type: image.mimeType,
        size_bytes: image.sizeBytes,
      }),
    },
  );

  if (!createUploadResponse.ok) {
    const text = await safeReadText(createUploadResponse);
    throw new Error(
      `Error preparing media upload (${createUploadResponse.status}). ${
        text || "Try again."
      }`,
    );
  }

  const uploadPayload = await safeReadJson(createUploadResponse);
  const uploadRecord = asRecord(uploadPayload);
  const mediaId =
    typeof uploadRecord?.media_id === "string" && uploadRecord.media_id.trim().length > 0
      ? uploadRecord.media_id.trim()
      : "";
  const uploadUrl =
    typeof uploadRecord?.upload_url === "string" && uploadRecord.upload_url.trim().length > 0
      ? uploadRecord.upload_url.trim()
      : "";

  if (!mediaId || !uploadUrl) {
    throw new Error("Invalid media upload payload from Post-Bridge.");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": image.mimeType,
    },
    cache: "no-store",
    body: image.bytes,
  });

  if (!uploadResponse.ok) {
    const text = await safeReadText(uploadResponse);
    throw new Error(
      `Error uploading media bytes (${uploadResponse.status}). ${
        text || "Try again."
      }`,
    );
  }

  return mediaId;
}

function postBridgeHeaders(): Record<string, string> {
  if (!POST_BRIDGE_API_KEY) {
    throw new Error("Missing POST_BRIDGE_API_KEY.");
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${POST_BRIDGE_API_KEY}`,
  };
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
          title: content.slice(0, 64) || "Article",
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

function normalizeSocialPosts(payload: unknown): SocialPostVariation[] {
  const list = pickArray(payload, ["data", "results", "posts", "variations"]);
  type RawSocialVariation = {
    variant: number;
    hook: string;
    post: string;
    cta: string;
    hashtags: string[];
    platform?: string;
  };

  const normalized = list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const hook = typeof record.hook === "string" ? record.hook.trim() : "";
      const post = typeof record.post === "string" ? record.post.trim() : "";
      const cta = typeof record.cta === "string" ? record.cta.trim() : "";
      const platform =
        typeof record.platform === "string" && record.platform.trim().length > 0
          ? record.platform.trim()
          : undefined;
      const hashtags = Array.isArray(record.hashtags)
        ? record.hashtags
            .map((value) => String(value).trim())
            .filter(Boolean)
        : [];
      if (!post) {
        return null;
      }
      const normalizedItem: RawSocialVariation = {
        variant: Number(record.variant) || 1,
        hook,
        post,
        cta,
        hashtags,
        platform,
      };
      return normalizedItem;
    })
    .filter((item): item is RawSocialVariation => Boolean(item));
  return normalized;
}

function normalizeSocialAccounts(payload: unknown): SocialAccount[] {
  const list = pickArray(payload, ["data", "accounts", "socialAccounts", "results"]);

  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;

      const id = Number(record.id ?? record.account_id ?? record.accountId);
      if (!Number.isInteger(id) || id <= 0) {
        return null;
      }

      const platform =
        typeof record.platform === "string" && record.platform.trim().length > 0
          ? record.platform.trim()
          : "unknown";

      const username =
        typeof record.username === "string" && record.username.trim().length > 0
          ? record.username.trim()
          : `account-${id}`;

      return { id, platform, username };
    })
    .filter((item): item is SocialAccount => Boolean(item))
    .sort((a, b) => {
      const byPlatform = a.platform.localeCompare(b.platform);
      if (byPlatform !== 0) return byPlatform;
      return a.username.localeCompare(b.username);
    });
}

function normalizeScheduledSocialPosts(
  payload: unknown,
): ScheduledSocialCalendarPost[] {
  const list = pickArray(payload, ["data", "posts", "results"]);

  return list
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;

      const idRaw = record.id ?? record.post_id ?? record.postId;
      if (idRaw === undefined || idRaw === null) {
        return null;
      }

      const id = String(idRaw).trim();
      if (!id) return null;

      const caption =
        typeof record.caption === "string" && record.caption.trim().length > 0
          ? record.caption.trim()
          : "Scheduled social post";

      const status =
        typeof record.status === "string" && record.status.trim().length > 0
          ? record.status.trim()
          : null;

      const scheduledAt = normalizeDateString(
        record.scheduled_at ?? record.scheduledAt,
      );

      const socialAccountIds = parseNumericIdArray(
        record.social_accounts ?? record.socialAccounts,
      );

      return {
        id,
        caption,
        status,
        scheduledAt,
        socialAccountIds,
      } as ScheduledSocialCalendarPost;
    })
    .filter((item): item is ScheduledSocialCalendarPost => Boolean(item));
}

function normalizeScheduledSocialPost(payload: unknown): ScheduledSocialPost | null {
  const root = asRecord(payload);
  if (!root) return null;

  const candidates: Record<string, unknown>[] = [root];
  const post = asRecord(root.post);
  if (post) candidates.push(post);
  const data = asRecord(root.data);
  if (data) candidates.push(data);
  const result = asRecord(root.result);
  if (result) candidates.push(result);

  for (const candidate of candidates) {
    const idRaw = candidate.id ?? candidate.post_id ?? candidate.postId;
    if (idRaw === undefined || idRaw === null) {
      continue;
    }

    const id = String(idRaw).trim();
    if (!id) continue;

    const status =
      typeof candidate.status === "string" && candidate.status.trim().length > 0
        ? candidate.status.trim()
        : null;

    const scheduledValue =
      candidate.scheduled_at ??
      candidate.scheduledAt ??
      root.scheduled_at ??
      root.scheduledAt;
    const scheduledDate = normalizeDateString(scheduledValue);

    return {
      id,
      status,
      scheduledAt: scheduledDate,
    };
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeDateString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

function parseNumericIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function sanitizePlatformConfigs(
  configs?: SocialPlatformConfigInput[],
): SocialPlatformConfigPayload[] {
  if (!Array.isArray(configs)) {
    return [];
  }

  return configs
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const platform =
        typeof entry.platform === "string" && entry.platform.trim().length > 0
          ? entry.platform.trim()
          : null;

      if (!platform) {
        return null;
      }

      const config: SocialPlatformConfigPayload = { platform };

      if (typeof entry.maxLength === "number" && Number.isFinite(entry.maxLength)) {
        config.maxLength = Math.min(1000, Math.max(40, Math.round(entry.maxLength)));
      }

      if (
        typeof entry.numVariations === "number" &&
        Number.isFinite(entry.numVariations)
      ) {
        config.numVariations = Math.max(1, Math.min(6, Math.round(entry.numVariations)));
      }

      if (typeof entry.hashtagsPolicy === "string" && entry.hashtagsPolicy.trim()) {
        config.hashtagsPolicy = entry.hashtagsPolicy.trim();
      }

      if (typeof entry.linksPolicy === "string" && entry.linksPolicy.trim()) {
        config.linksPolicy = entry.linksPolicy.trim();
      }

      if (typeof entry.ctaStyle === "string" && entry.ctaStyle.trim()) {
        config.ctaStyle = entry.ctaStyle.trim();
      }

      return config;
    })
    .filter((item): item is SocialPlatformConfigPayload => Boolean(item));
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
  VERY_LOW: { score: 15, label: "Very low" },
  LOW: { score: 30, label: "Low" },
  MEDIUM: { score: 55, label: "Medium" },
  HIGH: { score: 75, label: "High" },
  VERY_HIGH: { score: 90, label: "Very high" },
  EASY: { score: 25, label: "Easy" },
  HARD: { score: 85, label: "Hard" },
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

  if (score < 20) return "Very low";
  if (score < 40) return "Low";
  if (score < 60) return "Medium";
  if (score < 80) return "High";
  return "Very high";
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

// ---------------------------------------------------------------------------
// WordPress Blog Posts (reusable)
// ---------------------------------------------------------------------------

const WORDPRESS_API_BASE =
  process.env.WORDPRESS_API_BASE?.replace(/\/$/, "") ||
  "https://kodus.io/wp-json/wp/v2";

export type BlogPost = {
  id: string;
  title: string;
  link: string;
  publishedAt?: string;
};

export async function fetchBlogPosts(
  perPage = 20,
): Promise<BlogPost[]> {
  const endpoint = new URL(`${WORDPRESS_API_BASE}/posts`);
  endpoint.searchParams.set("per_page", String(perPage));
  endpoint.searchParams.set("orderby", "date");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("_fields", "id,title.rendered,link,date");

  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Error fetching blog posts (${response.status}).`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) return [];

  return data
    .map((item: Record<string, unknown>) => {
      const title =
        typeof item.title === "object" && item.title !== null
          ? String(
              (item.title as Record<string, unknown>).rendered ?? "",
            ).replace(/<[^>]*>/g, "")
          : "";
      const link = typeof item.link === "string" ? item.link : "";
      const date =
        typeof item.date === "string"
          ? new Date(item.date).toISOString()
          : undefined;
      if (!title || !link) return null;
      return { id: String(item.id), title, link, publishedAt: date } as BlogPost;
    })
    .filter((p: BlogPost | null): p is BlogPost => p !== null);
}
