// brand-mentions.ts — find pages that mention a brand on the web but
// don't link to its canonical domain. Output ranked candidates for
// link reclamation outreach.
//
// V1 uses Exa for discovery + scraping, plus an LLM classifier for
// relevance. No paid backlink-data subscription. Domain authority is
// proxied via content-quality heuristics (HTTPS + content length +
// LLM-judged niche fit), not measured.

import { generateText } from "ai";

import { getModel } from "@/lib/ai/provider";
import { searchWebContent, scrapePageContent } from "@/lib/exa";

export type BrandMentionCandidate = {
  url: string;
  title: string;
  domain: string;
  snippet: string | null;
  mentionContext: string | null;
  publishedDate: string | null;
  relevanceScore: number;
  sentiment: "positive" | "neutral" | "negative";
  rationale: string;
  contentLength: number;
  hasHttps: boolean;
  priorityScore: number;
};

export type FindUnlinkedBrandMentionsInput = {
  brand: string;
  canonicalDomain: string;
  daysBack?: number;
  numResults?: number;
  minRelevance?: number;
};

export type FindUnlinkedBrandMentionsOutput = {
  brand: string;
  totalDiscovered: number;
  totalSkippedAlreadyLinked: number;
  totalSkippedLowRelevance: number;
  totalSkippedNoise: number;
  candidates: BrandMentionCandidate[];
};

// Domains we always skip (covered by social-monitoring.ts or self-hosted).
export const NOISE_DOMAINS = [
  "reddit.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "github.com",
  "stackoverflow.com",
  "ycombinator.com",
  "news.ycombinator.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "medium.com", // medium-as-blog is real, but spam-heavy. include for V1; revisit V2.
  "kodus.io", // self
  "docs.kodus.io",
  "growth.kodus.io",
  "app.kodus.io",
  "codereviewbench.com", // owned
  "aicodereviews.io", // owned
];

// Conservative cap to prevent accidental Exa quota burns.
const MAX_NUM_RESULTS = 100;

// Truncate context window we send to LLM to keep cost predictable.
const MAX_CONTEXT_CHARS = 1500;

const RELEVANCE_PROMPT = `You classify whether a web page that mentions a brand
is a relevant link-reclamation outreach target.

The brand: "{{BRAND}}" — it's an open-source AI code review tool for software
engineering teams. Target audience: software engineers, engineering managers,
CTOs, dev tool decision makers.

Given the page below, return a JSON object (no prose). Schema:
{
  "is_relevant_niche": boolean,
  "sentiment": "positive" | "neutral" | "negative",
  "relevance_score": number,
  "rationale": string
}

Skip:
- Pages where "{{BRAND}}" is the name of an unrelated company/product/person
- Generic listicles where the brand is mentioned once without substance
- Off-topic content (lifestyle, gaming, finance, etc.)

Return JSON only.`;

export function normalizeDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function isNoiseDomain(url: string): boolean {
  const domain = normalizeDomain(url);
  return NOISE_DOMAINS.some(
    (noise) => domain === noise || domain.endsWith(`.${noise}`),
  );
}

// Detect if HTML/text contains a link to the canonical domain.
// We check both <a href> patterns and bare canonical-domain URLs in text,
// because Exa often returns plain text content without HTML markup.
export function hasLinkToCanonicalDomain(
  text: string,
  canonicalDomain: string,
): boolean {
  if (!text) return false;
  const escaped = canonicalDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(href=["'][^"']*${escaped}[^"']*["'])|(https?:\\/\\/[\\w.-]*${escaped})`,
    "i",
  );
  return pattern.test(text);
}

// Extract a short context snippet around the brand mention.
export function extractMentionContext(
  text: string,
  brand: string,
  maxChars = 400,
): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(brand.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - maxChars / 2);
  const end = Math.min(text.length, idx + brand.length + maxChars / 2);
  return text.slice(start, end).trim();
}

export type LlmClassification = {
  is_relevant_niche: boolean;
  sentiment: "positive" | "neutral" | "negative";
  relevance_score: number;
  rationale: string;
};

export function parseLlmJson(raw: string): LlmClassification | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const sentiment = parsed.sentiment;
    const score = parsed.relevance_score;
    if (
      typeof parsed.is_relevant_niche === "boolean" &&
      (sentiment === "positive" ||
        sentiment === "neutral" ||
        sentiment === "negative") &&
      typeof score === "number" &&
      typeof parsed.rationale === "string"
    ) {
      return {
        is_relevant_niche: parsed.is_relevant_niche,
        sentiment,
        relevance_score: Math.max(0, Math.min(1, score)),
        rationale: parsed.rationale,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

async function classifyMention(
  brand: string,
  context: string,
  domain: string,
): Promise<LlmClassification | null> {
  try {
    const { text } = await generateText({
      model: getModel(),
      system: RELEVANCE_PROMPT.replaceAll("{{BRAND}}", brand),
      prompt: `Domain: ${domain}\n\nMention context:\n${context.slice(0, MAX_CONTEXT_CHARS)}`,
    });
    return parseLlmJson(text);
  } catch (err) {
    console.error(
      "[brand-mentions] LLM classify failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function findUnlinkedBrandMentions(
  input: FindUnlinkedBrandMentionsInput,
): Promise<FindUnlinkedBrandMentionsOutput> {
  const {
    brand,
    canonicalDomain,
    daysBack = 30,
    numResults = 30,
    minRelevance = 0.6,
  } = input;

  if (!brand.trim()) {
    throw new Error("brand is required");
  }
  if (!canonicalDomain.trim()) {
    throw new Error("canonicalDomain is required");
  }

  const cappedNum = Math.min(MAX_NUM_RESULTS, Math.max(1, numResults));

  // Etapa 1: Exa discovery
  const { results: exaResults } = await searchWebContent({
    query: `"${brand}"`,
    excludeDomains: NOISE_DOMAINS,
    numResults: cappedNum,
    daysBack,
    textMaxCharacters: 4000,
  });

  let totalSkippedNoise = 0;
  let totalSkippedAlreadyLinked = 0;
  let totalSkippedLowRelevance = 0;
  const candidates: BrandMentionCandidate[] = [];

  // Defense in depth: re-filter noise (Exa exclude is best-effort).
  const filtered = exaResults.filter((r) => {
    if (isNoiseDomain(r.url)) {
      totalSkippedNoise++;
      return false;
    }
    return true;
  });

  // Etapa 2-4: scrape, detect existing link, classify.
  // Process serially to keep LLM cost bounded. With cappedNum=30 and ~5s per
  // round (scrape + LLM), worst case is ~2.5min total. Acceptable for a tool
  // that runs on-demand.
  for (const r of filtered) {
    let scraped: Awaited<ReturnType<typeof scrapePageContent>> | null = null;
    try {
      scraped = await scrapePageContent({
        url: r.url,
        maxCharacters: 8000,
        includeSummary: false,
        includeHighlights: false,
        livecrawl: "fallback",
      });
    } catch (err) {
      console.error(
        `[brand-mentions] scrape failed for ${r.url}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    const fullText = scraped.text ?? r.text ?? "";

    // Etapa 3: detect existing link
    if (hasLinkToCanonicalDomain(fullText, canonicalDomain)) {
      totalSkippedAlreadyLinked++;
      continue;
    }

    const mentionContext =
      extractMentionContext(fullText, brand) ?? r.summary ?? null;
    if (!mentionContext) {
      // No context = can't classify; skip conservatively
      continue;
    }

    // Etapa 4: LLM relevance
    const domain = normalizeDomain(r.url);
    const classification = await classifyMention(brand, mentionContext, domain);
    if (!classification) {
      // LLM failed; conservative skip
      continue;
    }
    if (
      !classification.is_relevant_niche ||
      classification.relevance_score < minRelevance
    ) {
      totalSkippedLowRelevance++;
      continue;
    }

    // Etapa 5: quality proxies
    const contentLength = fullText.length;
    const hasHttps = r.url.startsWith("https://");
    const contentQualityProxy =
      Math.min(1, contentLength / 2000) * (hasHttps ? 1 : 0.5);
    const priorityScore =
      classification.relevance_score * contentQualityProxy;

    candidates.push({
      url: r.url,
      title: r.title,
      domain,
      snippet: r.summary ?? null,
      mentionContext,
      publishedDate: r.publishedDate ?? null,
      relevanceScore: classification.relevance_score,
      sentiment: classification.sentiment,
      rationale: classification.rationale,
      contentLength,
      hasHttps,
      priorityScore,
    });
  }

  candidates.sort((a, b) => b.priorityScore - a.priorityScore);

  return {
    brand,
    totalDiscovered: exaResults.length,
    totalSkippedAlreadyLinked,
    totalSkippedLowRelevance,
    totalSkippedNoise,
    candidates,
  };
}
