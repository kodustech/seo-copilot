import { tool, generateText } from "ai";
import { z } from "zod";
import {
  enqueueKeywordTask,
  fetchKeywordTaskResult,
  fetchKeywordsHistory,
  fetchTitlesFromCopilot,
  enqueueArticleTask,
  fetchArticleTaskResult,
  generateSocialContent,
  fetchSocialAccounts,
  scheduleSocialPost,
  fetchBlogPosts,
} from "@/lib/copilot";
import { resolveVoicePolicyForUser } from "@/lib/voice-policy";
import {
  searchIdeas,
  searchCompetitorContent,
  searchWebContent,
  scrapePageContent,
} from "@/lib/exa";
import { findUnlinkedBrandMentions } from "@/lib/brand-mentions";
import {
  addRows,
  createTable,
  getDefaultRubricId,
  listRows,
  listTables,
} from "@/lib/research/tables";
import { researchRow } from "@/lib/research/research-company";
import { listRubrics } from "@/lib/research/rubrics";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import {
  listMentions,
  getMentionStats,
  type MentionFilters,
} from "@/lib/social-monitoring";
import {
  DEFAULT_SCHEDULE_TIME,
  buildCronExpressionForSchedule,
  createJob,
  deleteJob,
  describeCronExpression,
  listJobsByEmail,
  normalizeScheduleTime,
  type SchedulePreset,
} from "@/lib/scheduled-jobs";
import {
  querySearchPerformance,
  queryTrafficOverview,
  queryTopContent,
  queryContentOpportunities,
  queryComparePerformance,
  queryContentDecay,
  querySearchBySegment,
  queryPageKeywords,
  describeDataset,
  queryBigQuery,
} from "@/lib/bigquery";
import {
  listColumns,
  listWorkItems,
  createWorkItem,
  updateWorkItem,
  deleteWorkItem,
} from "@/lib/kanban";
import { createBet, deleteBet, listBets, updateBet, type BetStatus } from "@/lib/bets";
import { fetchFunnel } from "@/lib/funnel/metrics";
import { FUNNEL_METRICS } from "@/lib/funnel/goals";
import {
  listGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  incrementGoalProgress,
  listGoalLinks,
  addGoalLink,
  removeGoalLink,
  recalculateGoalProgress,
  currentWeekRange,
  currentMonthRange,
  type Goal,
} from "@/lib/goals";
import {
  createPrompt as createAiPrompt,
  deletePrompt as deleteAiPrompt,
  getSettings as getAiVisibilitySettings,
  getVisibilitySummary,
  runAiVisibility,
  updatePrompt as updateAiPrompt,
  updateSettings as updateAiVisibilitySettings,
  AI_ENGINES,
  DEFAULT_MODELS,
  ENGINE_LABEL,
  WEEKDAY_LABELS,
  type AiEngine,
  type EngineConfig,
} from "@/lib/ai-visibility";
import {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  createComment,
  recordManualOutreach,
  listContacts,
  createContact,
  updateContact,
  archiveContact,
  archiveCompany,
  restoreCompany,
  listComments,
  listActivities,
  listCompanySequences,
  COMPANY_STATUSES,
  COMPANY_PRIORITIES,
  COMPANY_PREP_VALUES,
  CRM_OUTREACH_CHANNELS,
  type CompanyStatus,
  type CompanyPriority,
  type CompanyPrep,
  type CrmOutreachChannel,
} from "@/lib/crm";
import { getProductSignals } from "@/lib/crm-signals";
import { TEMPLATE_TOKEN_HELP } from "@/lib/outreach/template-vars";
import { CRM_TIER_TRIGGERS } from "@/lib/product-signals/classify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getModel } from "@/lib/ai/provider";
import { CONTENT_PLAN_SYNTHESIS_PROMPT } from "@/lib/ai/system-prompt";
import { fetchKeywordVolumes, fetchSerpResults } from "@/lib/dataforseo";

const INTERNAL_APP_URL = resolveInternalAppUrl();

function resolveInternalAppUrl() {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    const host = vercel.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://${host}`;
  }

  return "http://localhost:3000";
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

async function pollUntilReady<T>(
  fn: () => Promise<{ ready: boolean } & T>,
  { initialDelay = 2000, maxDelay = 6000, maxAttempts = 40 } = {},
): Promise<{ ready: boolean } & T> {
  let delay = initialDelay;
  for (let i = 0; i < maxAttempts; i++) {
    const result = await fn();
    if (result.ready) return result;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, maxDelay);
  }
  return { ready: false } as { ready: boolean } & T;
}

function asSnippet(text: string | null, maxChars = 900): string | null {
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const generateIdeas = tool({
  description:
    "Researches real discussions on Reddit, dev.to, HackerNews, StackOverflow, Twitter/X, Medium, Hashnode, and LinkedIn to discover content ideas across 5 angles: pain points, questions, trends, comparisons, and best practices. (~5-10s)",
  inputSchema: z.object({
    topic: z.string().describe("Topic or niche to research ideas"),
    sources: z
      .array(z.string())
      .optional()
      .describe(
        "Domains to fetch (default: reddit.com, dev.to, news.ycombinator.com, stackoverflow.com, x.com, medium.com, hashnode.dev, linkedin.com)",
      ),
    daysBack: z
      .number()
      .min(7)
      .max(365)
      .optional()
      .default(90)
      .describe("Time range in days to fetch (7-365, default 90)"),
  }),
  execute: async ({ topic, sources, daysBack }) => {
    try {
      const { results, topic: searchTopic } = await searchIdeas({
        topic,
        domains: sources,
        daysBack,
      });
      return {
        success: true as const,
        topic: searchTopic,
        totalResults: results.length,
        results: results.map((r) => ({
          id: r.id,
          title: r.title,
          url: r.url,
          source: r.source,
          publishedDate: r.publishedDate,
          summary: r.summary,
          highlights: r.highlights,
          angle: r.angle,
          angleLabel: r.angleLabel,
          score: r.score,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error researching ideas.",
      };
    }
  },
});

function createGenerateKeywordsTool(userEmail?: string) {
  return tool({
    description:
      "Researches SEO keywords from an idea or topic. Returns search volume, CPC, and difficulty. Slow operation (~30-90s).",
    inputSchema: z.object({
      idea: z.string().describe("Topic or idea to research keywords"),
      limit: z
        .number()
        .min(5)
        .max(50)
        .optional()
        .default(20)
        .describe("Maximum number of keywords (5-50)"),
      language: z
        .string()
        .optional()
        .default("pt")
        .describe("Keyword language (ex: pt, en, es)"),
      locationCode: z
        .number()
        .optional()
        .default(2076)
        .describe("Location code (2076 = Brazil)"),
    }),
    execute: async ({ idea, limit, language, locationCode }) => {
      try {
        const voicePolicy = await resolveVoicePolicyForUser(userEmail);
        const { taskId } = await enqueueKeywordTask({
          idea,
          limit,
          language,
          locationCode,
          voicePolicy,
        });
        const result = await pollUntilReady(() =>
          fetchKeywordTaskResult(taskId),
        );
        if (!result.ready || !result.keywords?.length) {
          return {
            success: false as const,
            message: "Timeout ou nenhuma keyword encontrada. Tente novamente.",
          };
        }
        return {
          success: true as const,
          keywords: result.keywords.map((kw) => ({
            id: kw.id,
            phrase: kw.phrase,
            volume: kw.volume,
            cpc: kw.cpc,
            difficulty: kw.difficulty,
            difficultyLabel: kw.difficultyLabel,
          })),
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error ? error.message : "Error while pesquisar keywords.",
        };
      }
    },
  });
}

export const generateKeywords = createGenerateKeywordsTool();

export const getKeywordHistory = tool({
  description:
    "Fetches keyword research history with pagination. Returns up to `limit` items starting at `offset`, optionally filtered by phrase substring. Default limit is 50 — full history can exceed 4000+ keywords (>100KB), so always paginate. Use `phraseContains` to find a specific topic without dumping everything.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(50)
      .describe("Max items per page (default 50, hard cap 500)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Starting offset (default 0)"),
    phraseContains: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring filter on the keyword phrase. Apply BEFORE pagination.",
      ),
  }),
  execute: async ({
    limit,
    offset,
    phraseContains,
  }: {
    limit?: number;
    offset?: number;
    phraseContains?: string;
  }) => {
    try {
      const allKeywords = await fetchKeywordsHistory();
      const safeLimit = Math.min(Math.max(limit ?? 50, 1), 500);
      const safeOffset = Math.max(offset ?? 0, 0);

      const needle = phraseContains?.trim().toLowerCase();
      const filtered = needle
        ? allKeywords.filter((kw) =>
            (kw.phrase ?? "").toLowerCase().includes(needle),
          )
        : allKeywords;

      const page = filtered.slice(safeOffset, safeOffset + safeLimit);
      const nextOffset = safeOffset + page.length;
      const hasMore = nextOffset < filtered.length;

      return {
        success: true as const,
        total: filtered.length,
        offset: safeOffset,
        limit: safeLimit,
        returned: page.length,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        keywords: page.map((kw) => ({
          id: kw.id,
          phrase: kw.phrase,
          volume: kw.volume,
          cpc: kw.cpc,
          difficulty: kw.difficulty,
          difficultyLabel: kw.difficultyLabel,
          idea: kw.idea,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch history de keywords.",
      };
    }
  },
});

function createGenerateTitlesTool(userEmail?: string) {
  return tool({
    description:
      "Generates article title suggestions from keywords. Provide a list of keywords.",
    inputSchema: z.object({
      keywords: z
        .array(
          z.object({
            keyword: z.string().describe("A keyword principal"),
            instruction: z
              .string()
              .optional()
              .describe("Additional instruction for this keyword"),
          }),
        )
        .min(1)
        .describe("List of keywords to generate titles"),
    }),
    execute: async ({ keywords }) => {
      try {
        const voicePolicy = await resolveVoicePolicyForUser(userEmail);
        const { titles } = await fetchTitlesFromCopilot({ keywords, voicePolicy });
        return {
          success: true as const,
          titles: titles.map((t) => ({
            id: t.id,
            text: t.text,
            keywords: t.keywords,
            mood: t.mood,
          })),
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error ? error.message : "Error generating titles.",
        };
      }
    },
  });
}

export const generateTitles = createGenerateTitlesTool();

function createGenerateArticleTool(userEmail?: string) {
  return tool({
    description:
      "Generates a full blog article from a title and a primary keyword. Slow operation (~1-3 min).",
    inputSchema: z.object({
      title: z.string().describe("Title do article"),
      keyword: z.string().describe("Main article keyword"),
      useResearch: z
        .boolean()
        .optional()
        .default(true)
        .describe("Se deve usar pesquisa web para enriquecer o article"),
      researchInstructions: z
        .string()
        .optional()
        .describe("Instructions para a pesquisa"),
      customInstructions: z
        .string()
        .optional()
        .describe("Instructions customizadas para o article"),
    }),
    execute: async ({
      title,
      keyword,
      useResearch,
      researchInstructions,
      customInstructions,
    }) => {
      try {
        const voicePolicy = await resolveVoicePolicyForUser(userEmail);
        const { taskId } = await enqueueArticleTask({
          title,
          keyword,
          useResearch,
          researchInstructions,
          customInstructions,
          voicePolicy,
        });
        const result = await pollUntilReady(() =>
          fetchArticleTaskResult(taskId),
        );
        if (!result.ready || !result.articles?.length) {
          return {
            success: false as const,
            message: "Timeout ou nenhum article generated. Tente novamente.",
          };
        }
        const article = result.articles[0];
        return {
          success: true as const,
          article: {
            id: article.id,
            title: article.title,
            keyword: article.keyword,
            content: article.content,
            url: article.url,
            status: article.status,
          },
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error ? error.message : "Error generating article.",
        };
      }
    },
  });
}

export const generateArticle = createGenerateArticleTool();

function createGenerateSocialPostsTool(userEmail?: string) {
  return tool({
    description:
      "Gera posts para redes sociais (LinkedIn, Twitter/X, Instagram) a partir de um content base.",
    inputSchema: z.object({
      baseContent: z
        .string()
        .describe("Base content used to generate posts (example: article text)"),
      instructions: z
        .string()
        .optional()
        .describe("Instructions adicionais de estilo ou foco"),
      language: z
        .string()
        .optional()
        .default("pt-BR")
        .describe("Language dos posts"),
      tone: z
        .string()
        .optional()
        .default("personal, direct, technical, candid")
        .describe("Tom dos posts"),
      sourcePerspective: z
        .enum(["owned", "observed", "inspired"])
        .optional()
        .describe(
          "Who owns the source experience: owned, observed, or inspired",
        ),
      narrativeStyle: z
        .enum(["analysis", "storytelling", "hot_take", "lesson"])
        .optional()
        .describe(
          "Narrative shape for the post: analysis, storytelling, hot_take, or lesson",
        ),
      generationMode: z
        .enum([
          "content_marketing",
          "build_in_public",
          "adversarial",
          "product_update",
        ])
        .optional()
        .describe(
          "Generation mode: content_marketing, build_in_public, adversarial, or product_update",
        ),
      platforms: z
        .array(
          z.object({
            platform: z
              .string()
              .describe("Nome da plataforma (linkedin, twitter, instagram)"),
            numVariations: z
              .number()
              .optional()
              .default(2)
              .describe("Number of variations per platform"),
          }),
        )
        .optional()
        .default([
          { platform: "linkedin", numVariations: 2 },
          { platform: "twitter", numVariations: 2 },
        ])
        .describe("Target platforms and number of variations"),
    }),
    execute: async ({
      baseContent,
      instructions,
      language,
      tone,
      sourcePerspective,
      narrativeStyle,
      generationMode,
      platforms,
    }) => {
      try {
        const voicePolicy = await resolveVoicePolicyForUser(userEmail);
        const posts = await generateSocialContent({
          baseContent,
          instructions,
          language,
          tone,
          generationMode,
          sourcePerspective,
          narrativeStyle,
          platformConfigs: platforms.map((p) => ({
            platform: p.platform,
            numVariations: p.numVariations,
          })),
          voicePolicy,
        });
        return {
          success: true as const,
          posts: posts.map((p) => ({
            variant: p.variant,
            hook: p.hook,
            post: p.post,
            cta: p.cta,
            hashtags: p.hashtags,
            platform: p.platform,
          })),
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error
              ? error.message
              : "Error generating social posts.",
        };
      }
    },
  });
}

export const generateSocialPosts = createGenerateSocialPostsTool();

function createVoicePolicyTool(userEmail?: string) {
  return tool({
    description:
      "Fetches the merged voice policy (tone, persona, instructions) for the logged user.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const voicePolicy = await resolveVoicePolicyForUser(userEmail);
        return {
          success: true as const,
          voicePolicy,
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error
              ? error.message
              : "Error resolving voice policy.",
        };
      }
    },
  });
}

function createListSocialAccountsTool(userEmail?: string) {
  return tool({
    description:
      "Lists social accounts connected in Post-Bridge for scheduling social posts.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const accounts = await fetchSocialAccounts({ userEmail });
        return {
          success: true as const,
          accounts,
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error
              ? error.message
              : "Error fetching social accounts.",
        };
      }
    },
  });
}

export const listSocialAccounts = createListSocialAccountsTool();

function createScheduleSocialPostTool(userEmail?: string) {
  return tool({
    description:
      "Schedules a social post in Post-Bridge for one or more connected social accounts.",
    inputSchema: z.object({
      caption: z.string().describe("Full post caption/text to publish"),
      scheduledAt: z
        .string()
        .describe("Publish datetime in ISO format (example: 2026-02-25T14:00:00Z)"),
      socialAccountIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe("Target social account IDs from listSocialAccounts"),
    }),
    execute: async ({ caption, scheduledAt, socialAccountIds }) => {
      try {
        const post = await scheduleSocialPost({
          caption,
          scheduledAt,
          socialAccountIds,
          userEmail,
        });
        return {
          success: true as const,
          post,
          message: `Social post scheduled (${post.id}).`,
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error
              ? error.message
              : "Error scheduling social post.",
        };
      }
    },
  });
}

export const scheduleSocialPostTool = createScheduleSocialPostTool();

export const fetchBlogFeed = tool({
  description:
    "Fetches Kodus feed items for ideation. Supports blog posts (WordPress), changelog updates, or both.",
  inputSchema: z.object({
    source: z
      .enum(["blog", "changelog", "all"])
      .optional()
      .default("blog")
      .describe("Feed source: blog, changelog, or all"),
  }),
  execute: async ({ source }) => {
    try {
      const endpoint = new URL("/api/feed", INTERNAL_APP_URL);
      endpoint.searchParams.set("source", source ?? "blog");

      const response = await fetch(endpoint.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        const errorMessage =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Error while fetch feed (${response.status}).`;

        return {
          success: false as const,
          message: errorMessage,
        };
      }

      const rawPosts =
        typeof data === "object" &&
        data !== null &&
        "posts" in data &&
        Array.isArray((data as { posts?: unknown[] }).posts)
          ? (data as { posts: unknown[] }).posts
          : [];

      const posts = rawPosts
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }

          const record = entry as Record<string, unknown>;
          const id =
            typeof record.id === "string" || typeof record.id === "number"
              ? String(record.id)
              : null;
          const title =
            typeof record.title === "string" ? record.title.trim() : "";
          const link = typeof record.link === "string" ? record.link.trim() : "";
          const excerpt =
            typeof record.excerpt === "string" ? record.excerpt.trim() : "";
          const content =
            typeof record.content === "string" ? record.content.trim() : "";
          const publishedAt =
            typeof record.publishedAt === "string" && record.publishedAt.trim().length > 0
              ? record.publishedAt
              : undefined;
          const itemSource =
            record.source === "changelog"
              ? "changelog"
              : record.source === "blog"
                ? "blog"
                : source ?? "blog";

          if (!id || !title || !link) {
            return null;
          }

          return {
            id,
            title,
            link,
            excerpt,
            content,
            publishedAt,
            source: itemSource,
          };
        })
        .filter(Boolean);

      const resolvedSource =
        typeof data === "object" &&
        data !== null &&
        "source" in data &&
        typeof (data as { source?: unknown }).source === "string"
          ? (data as { source: string }).source
          : source ?? "blog";

      if (!posts.length) {
        return {
          success: true as const,
          source: resolvedSource,
          posts: [] as {
            id: string;
            title: string;
            link: string;
            excerpt: string;
            content: string;
            publishedAt: string | undefined;
            source: string;
          }[],
        };
      }

      return {
        success: true as const,
        source: resolvedSource,
        posts: posts as {
          id: string;
          title: string;
          link: string;
          excerpt: string;
          content: string;
          publishedAt: string | undefined;
          source: string;
        }[],
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error while fetch feed.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Content Plan (cross-data synthesis)
// ---------------------------------------------------------------------------

export const generateContentPlan = tool({
  description:
    "Generates a strategic content plan by combining 5 data sources: community (Exa), SEO opportunities (Search Console), content decay (Analytics), existing blog posts, and keyword history. Returns 5-8 ranked ideas with data-backed rationale. (~10-15s)",
  inputSchema: z.object({
    topic: z
      .string()
      .optional()
      .describe(
        "Focus of the content plan. If omitted, uses global data without topic filtering.",
      ),
    daysBack: z
      .number()
      .min(7)
      .max(365)
      .optional()
      .default(90)
      .describe("Time range in days to fetch community discussions (7-365, default 90)"),
    analyticsDays: z
      .number()
      .min(7)
      .max(90)
      .optional()
      .default(28)
      .describe("Time range in days for analytics data (7-90, default 28)"),
  }),
  execute: async ({ topic, daysBack, analyticsDays }) => {
    try {
      // Resolve analytics date range
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(
        Date.now() - analyticsDays * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);

      // 1. Fetch all 5 sources in parallel
      const [
        communityResult,
        opportunitiesResult,
        decayResult,
        blogResult,
        keywordsResult,
      ] = await Promise.allSettled([
        topic
          ? searchIdeas({ topic, daysBack })
          : Promise.resolve({ results: [], topic: "" }),
        queryContentOpportunities({ startDate, endDate, limit: 15 }),
        queryContentDecay({ startDate, endDate, limit: 15, minPageviews: 5 }),
        fetchBlogPosts(20),
        fetchKeywordsHistory(),
      ]);

      // 2. Extract data from settled results
      const community =
        communityResult.status === "fulfilled"
          ? communityResult.value.results
          : [];
      const opportunities =
        opportunitiesResult.status === "fulfilled"
          ? opportunitiesResult.value
          : { lowCtr: [], strikingDistance: [] };
      const decay =
        decayResult.status === "fulfilled"
          ? decayResult.value.decaying
          : [];
      const blogPosts =
        blogResult.status === "fulfilled" ? blogResult.value : [];
      const keywords =
        keywordsResult.status === "fulfilled"
          ? keywordsResult.value
          : [];

      // 3. Build compact context string (~2-3k tokens)
      const contextParts: string[] = [];

      if (topic) {
        contextParts.push(`## Plan focus: "${topic}"\n`);
      }

      if (community.length > 0) {
        contextParts.push("## Community discussions");
        community.slice(0, 10).forEach((r) => {
          contextParts.push(
            `- [${r.angleLabel}] "${r.title}" (${r.source})${r.summary ? `: ${r.summary.slice(0, 120)}` : ""}`,
          );
        });
        contextParts.push("");
      }

      if (
        opportunities.lowCtr.length > 0 ||
        opportunities.strikingDistance.length > 0
      ) {
        contextParts.push("## Oportunidades de SEO (Search Console)");
        if (opportunities.lowCtr.length > 0) {
          contextParts.push("### CTR Baixo (muitas impressions, CTR < 2%)");
          opportunities.lowCtr.slice(0, 8).forEach((r) => {
            contextParts.push(
              `- query="${r.query}" impr=${r.impressions} ctr=${(r.ctr * 100).toFixed(1)}% pos=${r.position.toFixed(1)} page=${r.page}`,
            );
          });
        }
        if (opportunities.strikingDistance.length > 0) {
          contextParts.push("### Striking Distance (position 5-20)");
          opportunities.strikingDistance.slice(0, 8).forEach((r) => {
            contextParts.push(
              `- query="${r.query}" impr=${r.impressions} pos=${r.position.toFixed(1)} page=${r.page}`,
            );
          });
        }
        contextParts.push("");
      }

      if (decay.length > 0) {
        contextParts.push("## Pages perdendo traffic (Content Decay)");
        decay.slice(0, 8).forEach((r) => {
          contextParts.push(
            `- ${r.page} — de ${r.previousPageviews} para ${r.currentPageviews} pageviews (${r.changePercent.toFixed(0)}%)`,
          );
        });
        contextParts.push("");
      }

      if (blogPosts.length > 0) {
        contextParts.push("## Posts already published on the blog");
        blogPosts.slice(0, 15).forEach((p) => {
          contextParts.push(
            `- "${p.title}" (${p.publishedAt?.slice(0, 10) ?? "sem data"})`,
          );
        });
        contextParts.push("");
      }

      if (keywords.length > 0) {
        contextParts.push("## Keywords already researched");
        keywords.slice(0, 15).forEach((kw) => {
          contextParts.push(
            `- "${kw.phrase}" vol=${kw.volume} diff=${kw.difficulty}${kw.idea ? ` (idea: ${kw.idea})` : ""}`,
          );
        });
        contextParts.push("");
      }

      const contextString = contextParts.join("\n");

      // 4. Use AI to synthesize and rank ideas
      const { text } = await generateText({
        model: getModel(),
        system: CONTENT_PLAN_SYNTHESIS_PROMPT,
        prompt: contextString || "No data available. Generate general ideas for a technology blog focused on DevOps, CI/CD, Code Review, and AI.",
      });

      // 5. Parse JSON response (handle optional code block wrapping)
      let parsed: Record<string, unknown>;
      try {
        const jsonStr = text
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        return {
          success: false as const,
          message: "Error while interpretar resposta da AI. Tente novamente.",
        };
      }

      return {
        success: true as const,
        summary: parsed.summary as string,
        ideas: parsed.ideas as unknown[],
        sourcesUsed: parsed.sourcesUsed as Record<string, number>,
        dataCounts: {
          community: community.length,
          opportunities:
            opportunities.lowCtr.length +
            opportunities.strikingDistance.length,
          decaying: decay.length,
          blogPosts: blogPosts.length,
          keywords: keywords.length,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error generating content plan.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Analytics Tools (BigQuery)
// ---------------------------------------------------------------------------

const dateSchema = {
  startDate: z
    .string()
    .optional()
    .describe("Start date (YYYY-MM-DD). Default: last 28 days."),
  endDate: z
    .string()
    .optional()
    .describe("End date (YYYY-MM-DD). Default: today."),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe("Maximum number of results (1-50, default 20)"),
};

export const getSearchPerformance = tool({
  description:
    "Fetches organic search performance metrics from Google Search Console (clicks, impressions, CTR, position). Returns totals plus top queries and top pages.",
  inputSchema: z.object(dateSchema),
  execute: async ({ startDate, endDate, limit }) => {
    try {
      const data = await querySearchPerformance({ startDate, endDate, limit });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch dados do Search Console.",
      };
    }
  },
});

export const getTrafficOverview = tool({
  description:
    "Fetches Google Analytics traffic overview: users, sessions, pageviews, traffic sources, and daily trend.",
  inputSchema: z.object(dateSchema),
  execute: async ({ startDate, endDate, limit }) => {
    try {
      const data = await queryTrafficOverview({ startDate, endDate, limit });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch dados de traffic.",
      };
    }
  },
});

export const getTopContent = tool({
  description:
    "Fetches pages with the most traffic in Google Analytics: pageviews and bounce rate. Accepts path filter (example: /blog).",
  inputSchema: z.object({
    ...dateSchema,
    pathFilter: z
      .string()
      .optional()
      .describe("Path filter (example: /blog). Returns pages that start with this prefix."),
  }),
  execute: async ({ startDate, endDate, limit, pathFilter }) => {
    try {
      const data = await queryTopContent({
        startDate,
        endDate,
        limit,
        pathFilter,
      });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch top content.",
      };
    }
  },
});

export const getContentOpportunities = tool({
  description:
    "Identifies content opportunities: queries with many impressions but low CTR (<2%), and striking-distance queries (position 5-20 on Google).",
  inputSchema: z.object(dateSchema),
  execute: async ({ startDate, endDate, limit }) => {
    try {
      const data = await queryContentOpportunities({
        startDate,
        endDate,
        limit,
      });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch oportunidades.",
      };
    }
  },
});

export const comparePerformance = tool({
  description:
    "Compares organic search metrics (Search Console) and traffic (GA) between the current and previous period of the same length. Returns totals plus percentage change.",
  inputSchema: z.object({
    startDate: z
      .string()
      .optional()
      .describe("Start date (YYYY-MM-DD). Default: last 28 days."),
    endDate: z
      .string()
      .optional()
      .describe("End date (YYYY-MM-DD). Default: today."),
  }),
  execute: async ({ startDate, endDate }) => {
    try {
      const data = await queryComparePerformance({ startDate, endDate });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error comparing periods.",
      };
    }
  },
});

export const getContentDecay = tool({
  description:
    "Identifies pages losing traffic by comparing the current period with the previous one. Returns pages with pageview decline sorted by largest drop.",
  inputSchema: z.object({
    startDate: z
      .string()
      .optional()
      .describe("Start date (YYYY-MM-DD). Default: last 28 days."),
    endDate: z
      .string()
      .optional()
      .describe("End date (YYYY-MM-DD). Default: today."),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(30)
      .describe("Maximum number of pages (1-50, default 30)"),
    minPageviews: z
      .number()
      .optional()
      .default(10)
      .describe("Minimum pageviews in the previous period to consider (default 10)"),
  }),
  execute: async ({ startDate, endDate, limit, minPageviews }) => {
    try {
      const data = await queryContentDecay({ startDate, endDate, limit, minPageviews });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch content decay.",
      };
    }
  },
});

export const getSearchBySegment = tool({
  description:
    "Analyzes organic search metrics segmented by device (DESKTOP, MOBILE, TABLET) or country. Returns clicks, impressions, CTR, and position by segment.",
  inputSchema: z.object({
    startDate: z
      .string()
      .optional()
      .describe("Start date (YYYY-MM-DD). Default: last 28 days."),
    endDate: z
      .string()
      .optional()
      .describe("End date (YYYY-MM-DD). Default: today."),
    segment: z
      .enum(["device", "country"])
      .describe("Segmento para agrupar: 'device' ou 'country'"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe("Maximum number of segments (1-50, default 20)"),
  }),
  execute: async ({ startDate, endDate, segment, limit }) => {
    try {
      const data = await querySearchBySegment({ startDate, endDate, segment, limit });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch dados por segmento.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Page Keywords (keyword-to-page mapping)
// ---------------------------------------------------------------------------

export const getPageKeywords = tool({
  description:
    "Shows which Google keywords bring traffic to a specific page. Accepts full URL or partial path (example: /blog/code-review). Returns clicks, impressions, CTR, and position for each keyword.",
  inputSchema: z.object({
    page: z
      .string()
      .describe("URL ou path da page (ex: /blog/code-review ou kodus.io/blog/code-review)"),
    startDate: z
      .string()
      .optional()
      .describe("Start date (YYYY-MM-DD). Default: last 28 days."),
    endDate: z
      .string()
      .optional()
      .describe("End date (YYYY-MM-DD). Default: today."),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(30)
      .describe("Maximum number of keywords (1-50, default 30)"),
  }),
  execute: async ({ page, startDate, endDate, limit }) => {
    try {
      const data = await queryPageKeywords({ page, startDate, endDate, limit });
      return { success: true as const, ...data };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while fetch keywords da page.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Competitor Analysis
// ---------------------------------------------------------------------------

export const analyzeCompetitor = tool({
  description:
    "Analyzes competitor content on a topic using web search. Returns the best articles found with summaries, highlights, and source. Useful to understand competitor coverage and differentiate.",
  inputSchema: z.object({
    topic: z
      .string()
      .describe("Topic to research competitor content (example: 'code review best practices')"),
    targetDomains: z
      .array(z.string())
      .optional()
      .describe("Specific competitor domains to focus on (example: ['linearb.io', 'atlassian.com'])"),
    numResults: z
      .number()
      .min(3)
      .max(20)
      .optional()
      .default(10)
      .describe("Number of results (3-20, default 10)"),
    daysBack: z
      .number()
      .min(30)
      .max(365)
      .optional()
      .default(180)
      .describe("Time range in days to search (30-365, default 180)"),
  }),
  execute: async ({ topic, targetDomains, numResults, daysBack }) => {
    try {
      const data = await searchCompetitorContent({
        topic,
        targetDomains,
        numResults,
        daysBack,
      });
      return {
        success: true as const,
        topic: data.topic,
        totalResults: data.results.length,
        results: data.results.map((r) => ({
          id: r.id,
          title: r.title,
          url: r.url,
          source: r.source,
          publishedDate: r.publishedDate,
          summary: r.summary,
          highlights: r.highlights,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while analisar concorrentes.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Generic Web Research + Scraping
// ---------------------------------------------------------------------------

export const searchWeb = tool({
  description:
    "Runs a generic web search and returns ranked results with summaries/highlights. Supports domain filters (example: domains=['reddit.com'] for Reddit-only research).",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Search query (example: 'code review bottlenecks in startup teams')"),
    domains: z
      .array(z.string())
      .optional()
      .describe("Optional allowlist of domains (example: ['reddit.com', 'news.ycombinator.com'])"),
    excludeDomains: z
      .array(z.string())
      .optional()
      .describe("Optional blocklist of domains to exclude"),
    numResults: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .default(10)
      .describe("Number of results (1-20, default 10)"),
    daysBack: z
      .number()
      .min(7)
      .max(730)
      .optional()
      .default(365)
      .describe("Only search pages published in the last N days (7-730, default 365)"),
    textMaxCharacters: z
      .number()
      .min(1000)
      .max(12000)
      .optional()
      .default(4000)
      .describe("Maximum extracted text per result (1000-12000, default 4000)"),
  }),
  execute: async ({
    query,
    domains,
    excludeDomains,
    numResults,
    daysBack,
    textMaxCharacters,
  }) => {
    try {
      const data = await searchWebContent({
        query,
        domains,
        excludeDomains,
        numResults,
        daysBack,
        textMaxCharacters,
      });
      return {
        success: true as const,
        query: data.query,
        totalResults: data.results.length,
        results: data.results.map((r) => ({
          id: r.id,
          title: r.title,
          url: r.url,
          source: r.source,
          publishedDate: r.publishedDate,
          summary: r.summary,
          highlights: r.highlights,
          textSnippet: asSnippet(r.text),
          score: r.score,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while running generic web search.",
      };
    }
  },
});

export const scrapePage = tool({
  description:
    "Extracts clean content from a specific URL (title, summary, highlights, and text). Use when the user shares a direct link.",
  inputSchema: z.object({
    url: z
      .string()
      .url()
      .describe("The page URL to extract content from"),
    maxCharacters: z
      .number()
      .min(1000)
      .max(20000)
      .optional()
      .default(8000)
      .describe("Maximum text characters to extract (1000-20000, default 8000)"),
    includeSummary: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include an AI summary"),
    includeHighlights: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include key highlights"),
    livecrawl: z
      .enum(["never", "fallback", "always", "auto", "preferred"])
      .optional()
      .default("fallback")
      .describe("Live crawl mode"),
  }),
  execute: async ({
    url,
    maxCharacters,
    includeSummary,
    includeHighlights,
    livecrawl,
  }) => {
    try {
      const page = await scrapePageContent({
        url,
        maxCharacters,
        includeSummary,
        includeHighlights,
        livecrawl,
      });
      return {
        success: true as const,
        page: {
          ...page,
          textLength: page.text?.length ?? 0,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error while scraping page content.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Link Reclamation
// ---------------------------------------------------------------------------

export const findUnlinkedBrandMentionsTool = tool({
  description:
    "Discovers web pages that mention a brand but don't link to its canonical domain. Returns ranked candidates for link reclamation outreach. Use when the user asks to 'find unlinked mentions', 'find link reclamation candidates', or 'who mentioned us without linking'.",
  inputSchema: z.object({
    brand: z
      .string()
      .min(1)
      .describe(
        "Brand name to search for (e.g. 'Kodus'). Strict quote-match used.",
      ),
    canonicalDomain: z
      .string()
      .min(1)
      .describe(
        "Canonical domain to detect existing links to (e.g. 'kodus.io').",
      ),
    daysBack: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .default(30)
      .describe("Search window in days. Default 30."),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(30)
      .describe("Max Exa results to fetch and evaluate. Default 30, max 100."),
    minRelevance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.6)
      .describe(
        "Minimum LLM relevance score (0-1) to include in results. Default 0.6.",
      ),
  }),
  execute: async ({
    brand,
    canonicalDomain,
    daysBack,
    numResults,
    minRelevance,
  }) => {
    try {
      const result = await findUnlinkedBrandMentions({
        brand,
        canonicalDomain,
        daysBack,
        numResults,
        minRelevance,
      });
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Error finding unlinked brand mentions.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Scheduled Jobs Tools
// ---------------------------------------------------------------------------

export const scheduleJob = tool({
  description:
    "Creates a scheduled job that runs a prompt automatically on a recurring basis and sends results via webhook.",
  inputSchema: z.object({
    user_email: z.string().describe("Email of the user creating the job"),
    name: z.string().describe("Descriptive job name (example: 'Weekly SEO Report')"),
    prompt: z.string().describe("The prompt that will run automatically at each execution"),
    schedule: z
      .enum(["daily_9am", "weekly_monday", "weekly_friday", "biweekly", "monthly_first"])
      .describe("Schedule frequency"),
    time: z
      .string()
      .optional()
      .describe("Optional time in HH:mm (24-hour format). Defaults to 09:00."),
    webhook_url: z.string().url().describe("Webhook URL that receives the result via POST"),
  }),
  execute: async ({ user_email, name, prompt, schedule, time, webhook_url }) => {
    try {
      const client = getSupabaseServiceClient();
      const selectedTime = time ? normalizeScheduleTime(time) : DEFAULT_SCHEDULE_TIME;
      if (!selectedTime) {
        return {
          success: false as const,
          message: "Invalid time format. Use HH:mm, for example 14:30.",
        };
      }

      const cronExpression = buildCronExpressionForSchedule(
        schedule as SchedulePreset,
        selectedTime,
      );
      if (!cronExpression) {
        return {
          success: false as const,
          message: "Could not build cron expression for this schedule.",
        };
      }

      const job = await createJob(client, {
        user_email,
        name,
        prompt,
        cron_expression: cronExpression,
        webhook_url,
      });
      return {
        success: true as const,
        job: {
          id: job.id,
          name: job.name,
          schedule: describeCronExpression(cronExpression),
          cron: cronExpression,
          webhook_url: job.webhook_url,
          enabled: job.enabled,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error while criar job scheduled.",
      };
    }
  },
});

export const listScheduledJobs = tool({
  description: "Lists all scheduled jobs for the user.",
  inputSchema: z.object({
    user_email: z.string().describe("User email"),
  }),
  execute: async ({ user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const jobs = await listJobsByEmail(client, user_email);
      return {
        success: true as const,
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          prompt: j.prompt.slice(0, 100) + (j.prompt.length > 100 ? "..." : ""),
          cron_expression: j.cron_expression,
          schedule_label: describeCronExpression(j.cron_expression),
          webhook_url: j.webhook_url,
          enabled: j.enabled,
          last_run_at: j.last_run_at,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error while listar jobs.",
      };
    }
  },
});

export const deleteScheduledJob = tool({
  description: "Removes a user's scheduled job.",
  inputSchema: z.object({
    user_email: z.string().describe("User email"),
    job_id: z.string().uuid().describe("ID do job a ser removido"),
  }),
  execute: async ({ user_email, job_id }) => {
    try {
      const client = getSupabaseServiceClient();
      await deleteJob(client, job_id, user_email);
      return {
        success: true as const,
        message: `Job ${job_id} removido com sucesso.`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error while deletar job.",
      };
    }
  },
});

export const scheduleArticlePublication = tool({
  description:
    "Schedules automatic article publication. Creates a scheduled job that generates the article from title and keyword and publishes it automatically. No webhook required; it publishes directly to WordPress.",
  inputSchema: z.object({
    user_email: z.string().describe("User email creating the schedule"),
    title: z.string().describe("Title do article a ser generated"),
    keyword: z.string().describe("Main article keyword"),
    schedule: z
      .enum(["daily_9am", "weekly_monday", "weekly_friday", "biweekly", "monthly_first"])
      .describe("Quando publicar o article"),
    time: z
      .string()
      .optional()
      .describe("Horário opcional em HH:mm (24h). Padrão: 09:00"),
    useResearch: z
      .boolean()
      .optional()
      .default(true)
      .describe("Se deve usar pesquisa web para enriquecer o article"),
    customInstructions: z
      .string()
      .optional()
      .describe("Instructions customizadas para o article"),
  }),
  execute: async ({
    user_email,
    title,
    keyword,
    schedule,
    time,
    useResearch,
    customInstructions,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const selectedTime = time ? normalizeScheduleTime(time) : DEFAULT_SCHEDULE_TIME;
      if (!selectedTime) {
        return {
          success: false as const,
          message: "Invalid time format. Use HH:mm, for example 14:30.",
        };
      }

      const cronExpression = buildCronExpressionForSchedule(
        schedule as SchedulePreset,
        selectedTime,
      );
      if (!cronExpression) {
        return {
          success: false as const,
          message: "Could not build cron expression for this schedule.",
        };
      }

      // Build a self-contained prompt that the job executor will run
      const articlePrompt = [
        `Gere e publique um article com o title "${title}" e keyword principal "${keyword}".`,
        useResearch ? "Use pesquisa web para enriquecer o content." : "",
        customInstructions ? `Instructions adicionais: ${customInstructions}` : "",
        "Execute generateArticle imediatamente.",
      ]
        .filter(Boolean)
        .join(" ");

      // Use the internal app URL as webhook so results stay in the system
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000";

      const job = await createJob(client, {
        user_email,
        name: `Publicar: ${title.slice(0, 60)}`,
        prompt: articlePrompt,
        cron_expression: cronExpression,
        webhook_url: `${appUrl}/api/canvas/explore`,
      });

      const scheduleLabel = describeCronExpression(cronExpression);

      return {
        success: true as const,
        job: {
          id: job.id,
          name: job.name,
          title,
          keyword,
          schedule: scheduleLabel,
          cron: cronExpression,
          enabled: job.enabled,
        },
        message: `Article "${title}" scheduled for ${scheduleLabel}. The article will be generated and published automatically.`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error scheduling publication.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// DataForSEO: Keyword Volume
// ---------------------------------------------------------------------------

const getKeywordVolume = tool({
  description:
    "Fetches search volume, CPC, competition, and monthly trend for up to 50 keywords from Google Ads data. Cost: ~$0.05 per call. Use this for quick volume checks on specific keywords.",
  inputSchema: z.object({
    keywords: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("Keywords to check volume for (max 50)"),
    locationCode: z
      .number()
      .optional()
      .default(2840)
      .describe("Google Ads location code (default: 2840 = United States)"),
    languageCode: z
      .string()
      .optional()
      .default("en")
      .describe("Language code (default: en)"),
  }),
  execute: async ({ keywords, locationCode, languageCode }) => {
    try {
      const results = await fetchKeywordVolumes(keywords, locationCode, languageCode);
      return {
        success: true as const,
        count: results.length,
        keywords: results.map((r) => ({
          keyword: r.keyword,
          searchVolume: r.search_volume,
          cpc: r.cpc,
          competition: r.competition,
          competitionIndex: r.competition_index,
          monthlyTrend: r.monthly_searches?.slice(-6) ?? [],
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error fetching keyword volumes.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// DataForSEO: SERP Analysis
// ---------------------------------------------------------------------------

const analyzeSERP = tool({
  description:
    "Fetches live Google organic search results for a keyword — shows who ranks, in what position, with titles and descriptions. Cost: ~$0.003 per call. Use this to analyze competition for a keyword or check if kodus.io ranks.",
  inputSchema: z.object({
    keyword: z.string().describe("Search query to analyze"),
    depth: z
      .number()
      .min(10)
      .max(50)
      .optional()
      .default(10)
      .describe("Number of results to fetch (default: 10, max: 50)"),
    locationCode: z
      .number()
      .optional()
      .default(2840)
      .describe("Google location code (default: 2840 = United States)"),
    languageCode: z
      .string()
      .optional()
      .default("en")
      .describe("Language code (default: en)"),
  }),
  execute: async ({ keyword, depth, locationCode, languageCode }) => {
    try {
      const result = await fetchSerpResults(keyword, locationCode, languageCode, depth);
      if (!result) {
        return { success: false as const, message: "No SERP results returned." };
      }

      const kodusPosition = result.items.find(
        (item) => item.domain.includes("kodus.io") || item.url.includes("kodus.io"),
      );

      return {
        success: true as const,
        keyword: result.keyword,
        totalResults: result.se_results_count,
        kodusRanking: kodusPosition
          ? { position: kodusPosition.rank_absolute, url: kodusPosition.url, title: kodusPosition.title }
          : null,
        results: result.items.map((item) => ({
          position: item.rank_absolute,
          type: item.type,
          domain: item.domain,
          title: item.title,
          url: item.url,
          description: item.description,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error fetching SERP results.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// BigQuery: schema discovery + free-form query
// ---------------------------------------------------------------------------

export const exploreDataWarehouse = tool({
  description:
    "Explore the BigQuery data warehouse schema. Without a dataset parameter, returns a summary of all datasets and their tables. With a dataset name (e.g. 'kodus_mongo'), returns full column details, types, enums, and relations for every table in that dataset.",
  inputSchema: z.object({
    dataset: z
      .string()
      .optional()
      .describe(
        "Dataset name to inspect (e.g. 'kodus_billing', 'kodus_ga', 'kodus_search_console', 'kodus_mongo', 'kodus_postgres', 'kodus_posthog'). Omit to list all datasets.",
      ),
  }),
  execute: async ({ dataset }: { dataset?: string }) => {
    try {
      return { success: true as const, ...(await describeDataset(dataset)) };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error describing dataset.",
      };
    }
  },
});

export const runBigQuery = tool({
  description:
    "Execute a read-only SQL query against the BigQuery data warehouse. Only SELECT statements are allowed. Use exploreDataWarehouse first to discover table names and columns. Always use fully qualified table names (e.g. `kody-408918.kodus_mongo.pullRequests`). A LIMIT is enforced automatically if omitted.",
  inputSchema: z.object({
    sql: z.string().describe("The SQL SELECT query to execute."),
    maxRows: z
      .number()
      .optional()
      .default(100)
      .describe("Maximum rows to return (default 100, max 500)."),
  }),
  execute: async ({ sql, maxRows }: { sql: string; maxRows?: number }) => {
    try {
      const capped = Math.min(maxRows ?? 100, 500);
      const result = await queryBigQuery(sql, capped);
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error executing query.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Self-hosted product telemetry (Neon Postgres — kodus_telemetry)
// ---------------------------------------------------------------------------

export const exploreTelemetry = tool({
  description:
    "Explore Kodus self-hosted product telemetry schema (Neon Postgres). Lists tables/columns for instance heartbeats from customer self-hosted installs. Prefer listTelemetryInstances / getTelemetryInstance for common questions; use this before runTelemetryQuery for free-form SQL.",
  inputSchema: z.object({
    table: z
      .string()
      .optional()
      .describe(
        "Optional table name filter (e.g. telemetry_instances, telemetry_heartbeats).",
      ),
  }),
  execute: async ({ table }: { table?: string }) => {
    try {
      const {
        describeTelemetrySchema,
        isTelemetryConfigured,
      } = await import("@/lib/telemetry-pg");
      if (!isTelemetryConfigured()) {
        return {
          success: false as const,
          message:
            "TELEMETRY_DATABASE_URL is not set on this environment. Add the read-only Neon connection string.",
        };
      }
      const schema = await describeTelemetrySchema({ table });
      return { success: true as const, ...schema };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error describing telemetry.",
      };
    }
  },
});

export const listTelemetryInstances = tool({
  description:
    "List self-hosted Kodus instances that have sent product telemetry heartbeats (version, deployment, last seen, heartbeat count). Use for fleet overview / adoption questions.",
  inputSchema: z.object({
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max instances to return (default 50, max 200)."),
    activeDays: z
      .number()
      .optional()
      .describe(
        "If set, only instances with last_seen_at within this many days.",
      ),
  }),
  execute: async ({
    limit,
    activeDays,
  }: {
    limit?: number;
    activeDays?: number;
  }) => {
    try {
      const {
        listTelemetryInstances: listInstances,
        isTelemetryConfigured,
      } = await import("@/lib/telemetry-pg");
      if (!isTelemetryConfigured()) {
        return {
          success: false as const,
          message: "TELEMETRY_DATABASE_URL is not set on this environment.",
        };
      }
      const result = await listInstances({ limit, activeDays });
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error listing instances.",
      };
    }
  },
});

export const getTelemetryInstance = tool({
  description:
    "Get one self-hosted instance plus recent heartbeat payloads (usage_7d, config, runtime, kodus version). Pass the instance UUID from listTelemetryInstances.",
  inputSchema: z.object({
    instanceId: z.string().describe("Instance UUID."),
    heartbeats: z
      .number()
      .optional()
      .default(7)
      .describe("How many recent heartbeats to include (default 7, max 30)."),
  }),
  execute: async ({
    instanceId,
    heartbeats,
  }: {
    instanceId: string;
    heartbeats?: number;
  }) => {
    try {
      const {
        getTelemetryInstance: getInstance,
        isTelemetryConfigured,
      } = await import("@/lib/telemetry-pg");
      if (!isTelemetryConfigured()) {
        return {
          success: false as const,
          message: "TELEMETRY_DATABASE_URL is not set on this environment.",
        };
      }
      const result = await getInstance({ instanceId, heartbeats });
      if (!result.instance) {
        return {
          success: false as const,
          message: `Instance not found: ${instanceId}`,
        };
      }
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error loading instance.",
      };
    }
  },
});

export const runTelemetryQuery = tool({
  description:
    "Run a read-only SQL SELECT against the self-hosted telemetry Postgres (kodus_telemetry). Tables: telemetry_instances, telemetry_heartbeats (payload jsonb). Use exploreTelemetry first. LIMIT auto-applied (default 100, max 500).",
  inputSchema: z.object({
    sql: z
      .string()
      .describe(
        "SELECT/WITH query only. Example: SELECT last_version, count(*) FROM telemetry_instances GROUP BY 1 ORDER BY 2 DESC",
      ),
    maxRows: z
      .number()
      .optional()
      .default(100)
      .describe("Max rows (default 100, max 500)."),
  }),
  execute: async ({ sql, maxRows }: { sql: string; maxRows?: number }) => {
    try {
      const {
        runTelemetryQuery: runQuery,
        isTelemetryConfigured,
      } = await import("@/lib/telemetry-pg");
      if (!isTelemetryConfigured()) {
        return {
          success: false as const,
          message: "TELEMETRY_DATABASE_URL is not set on this environment.",
        };
      }
      const result = await runQuery({ sql, maxRows });
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error executing telemetry SQL.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Kanban tools (agent-driven card management)
// ---------------------------------------------------------------------------

function createKanbanCardTool(userEmail?: string) {
  return tool({
    description:
      "Create a new card on the shared Kanban board. Use for content pieces (article/idea/keyword/title/social), content updates (update — CTR fix, schema sweep, page rewrite), or generic tasks (task — build endpoint, rotate token, decide subscription, write spec).",
    inputSchema: z.object({
      title: z.string().describe("Card title"),
      description: z.string().optional().describe("Card description"),
      columnName: z
        .string()
        .optional()
        .describe("Column name to place the card in (e.g. 'Backlog', 'Doing'). Defaults to first column."),
      priority: z.enum(["low", "medium", "high"]).optional().describe("Priority level"),
      itemType: z
        .enum(["idea", "keyword", "title", "article", "social", "update", "task"])
        .optional()
        .describe(
          "Type of work item. 'update' = improving an existing page (CTR/schema/rewrite). 'task' = ops/dev/decision (no content generation). Content types follow the gen pipeline.",
        ),
      link: z.string().optional().describe("Reference URL"),
      responsible: z
        .string()
        .optional()
        .describe(
          "Email of the person responsible for this card (assignee). Distinct from creator. Use the team member's full email (e.g. 'gabriel@kodus.io', 'edvaldo.freitas@kodus.io', 'junior.sartori@kodus.io').",
        ),
    }),
    execute: async ({
      title,
      description,
      columnName,
      priority,
      itemType,
      link,
      responsible,
    }: {
      title: string;
      description?: string;
      columnName?: string;
      priority?: "low" | "medium" | "high";
      itemType?:
        | "idea"
        | "keyword"
        | "title"
        | "article"
        | "social"
        | "update"
        | "task";
      link?: string;
      responsible?: string;
    }) => {
      try {
        const client = getSupabaseServiceClient();
        const columns = await listColumns(client);
        if (!columns.length) {
          return { success: false as const, message: "No columns found. Create columns first." };
        }

        let targetCol = columns[0];
        if (columnName) {
          const match = columns.find(
            (c) => c.name.toLowerCase() === columnName.toLowerCase(),
          );
          if (match) targetCol = match;
        }

        const item = await createWorkItem(client, userEmail ?? "agent@kodus.io", {
          title,
          description,
          columnId: targetCol.id,
          stage: (targetCol.slug as "backlog") ?? "backlog",
          priority: priority ?? "medium",
          itemType: itemType ?? "idea",
          source: "agent",
          link,
          responsibleEmail: responsible ?? null,
        });

        return {
          success: true as const,
          card: { id: item.id, title: item.title, column: targetCol.name, priority: item.priority },
        };
      } catch (error) {
        return {
          success: false as const,
          message: error instanceof Error ? error.message : "Error creating card.",
        };
      }
    },
  });
}

function createMoveKanbanCardTool(userEmail?: string) {
  return tool({
    description:
      "Move an existing Kanban card to a different column. Searches by title (partial match).",
    inputSchema: z.object({
      cardTitle: z.string().describe("Title or partial title of the card to move"),
      targetColumn: z.string().describe("Name of the destination column"),
    }),
    execute: async ({
      cardTitle,
      targetColumn,
    }: {
      cardTitle: string;
      targetColumn: string;
    }) => {
      try {
        const client = getSupabaseServiceClient();
        const [allItems, columns] = await Promise.all([
          listWorkItems(client),
          listColumns(client),
        ]);

        const needle = cardTitle.toLowerCase();
        const matches = allItems.filter((i) =>
          i.title.toLowerCase().includes(needle),
        );

        if (matches.length === 0) {
          return { success: false as const, message: `No card found matching "${cardTitle}".` };
        }
        if (matches.length > 3) {
          return {
            success: false as const,
            message: `Too many matches (${matches.length}). Be more specific. Top matches: ${matches
              .slice(0, 5)
              .map((m) => `"${m.title}"`)
              .join(", ")}`,
          };
        }

        const destCol = columns.find(
          (c) => c.name.toLowerCase() === targetColumn.toLowerCase(),
        );
        if (!destCol) {
          return {
            success: false as const,
            message: `Column "${targetColumn}" not found. Available: ${columns.map((c) => c.name).join(", ")}`,
          };
        }

        const card = matches[0];
        await updateWorkItem(client, userEmail ?? "agent@kodus.io", card.id, {
          columnId: destCol.id,
          stage: (destCol.slug as "backlog") ?? undefined,
        });

        return {
          success: true as const,
          moved: { title: card.title, from: card.columnId, to: destCol.name },
          ...(matches.length > 1
            ? { note: `Moved first match. Other matches: ${matches.slice(1).map((m) => `"${m.title}"`).join(", ")}` }
            : {}),
        };
      } catch (error) {
        return {
          success: false as const,
          message: error instanceof Error ? error.message : "Error moving card.",
        };
      }
    },
  });
}

function createUpdateKanbanCardTool(userEmail?: string) {
  return tool({
    description:
      "Update an existing Kanban card. Find by exact card id (UUID) or by partial title match. Use to set/change the responsible person (assignee), priority, item type, link, description, or to rename. Does not move columns — use moveKanbanCard for that.",
    inputSchema: z.object({
      cardId: z
        .string()
        .optional()
        .describe(
          "Exact UUID of the card. Preferred over cardTitle for precision. If both provided, cardId wins.",
        ),
      cardTitle: z
        .string()
        .optional()
        .describe(
          "Title or partial title (case-insensitive). Used only when cardId is not provided. If multiple cards match, returns an error listing matches.",
        ),
      responsible: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Assignee email (e.g. 'gabriel@kodus.io'). Pass null to unassign.",
        ),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      priority: z.enum(["low", "medium", "high"]).optional(),
      itemType: z
        .enum(["idea", "keyword", "title", "article", "social", "update", "task"])
        .optional(),
      link: z.string().optional().describe("Reference URL"),
    }),
    execute: async ({
      cardId,
      cardTitle,
      responsible,
      title,
      description,
      priority,
      itemType,
      link,
    }: {
      cardId?: string;
      cardTitle?: string;
      responsible?: string | null;
      title?: string;
      description?: string;
      priority?: "low" | "medium" | "high";
      itemType?:
        | "idea"
        | "keyword"
        | "title"
        | "article"
        | "social"
        | "update"
        | "task";
      link?: string;
    }) => {
      try {
        const client = getSupabaseServiceClient();
        let id = cardId;

        if (!id) {
          if (!cardTitle) {
            return {
              success: false as const,
              message: "Provide either cardId or cardTitle.",
            };
          }
          const all = await listWorkItems(client);
          const needle = cardTitle.toLowerCase();
          const matches = all.filter((i) =>
            i.title.toLowerCase().includes(needle),
          );
          if (!matches.length) {
            return {
              success: false as const,
              message: `No card matched title "${cardTitle}".`,
            };
          }
          if (matches.length > 1) {
            return {
              success: false as const,
              message: `Multiple cards matched "${cardTitle}". Use cardId.`,
              matches: matches.map((m) => ({ id: m.id, title: m.title })),
            };
          }
          id = matches[0].id;
        }

        const updates: Parameters<typeof updateWorkItem>[3] = {};
        if (typeof responsible !== "undefined") updates.responsibleEmail = responsible;
        if (typeof title !== "undefined") updates.title = title;
        if (typeof description !== "undefined") updates.description = description;
        if (typeof priority !== "undefined") updates.priority = priority;
        if (typeof itemType !== "undefined") updates.itemType = itemType;
        if (typeof link !== "undefined") updates.link = link;

        if (!Object.keys(updates).length) {
          return {
            success: false as const,
            message: "No fields to update. Provide at least one.",
          };
        }

        const item = await updateWorkItem(
          client,
          userEmail ?? "agent@kodus.io",
          id,
          updates,
        );

        return {
          success: true as const,
          card: {
            id: item.id,
            title: item.title,
            responsible: item.responsibleEmail,
            priority: item.priority,
            itemType: item.itemType,
          },
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error ? error.message : "Error updating card.",
        };
      }
    },
  });
}

function createDeleteKanbanCardTool(_userEmail?: string) {
  return tool({
    description:
      "Delete a Kanban card permanently. Find by exact card id (UUID) or by partial title match. Destructive — there is no undo. Use only when the card is genuinely no longer needed (e.g. completed cleanup tasks, duplicates, mistakes). Prefer moveKanbanCard to a 'Done' column for normal completion.",
    inputSchema: z.object({
      cardId: z
        .string()
        .optional()
        .describe(
          "Exact UUID of the card. Preferred over cardTitle for precision. If both provided, cardId wins.",
        ),
      cardTitle: z
        .string()
        .optional()
        .describe(
          "Title or partial title (case-insensitive). Used only when cardId is not provided. If multiple cards match, returns an error listing matches — refusing to delete any to avoid wrong target.",
        ),
    }),
    execute: async ({
      cardId,
      cardTitle,
    }: {
      cardId?: string;
      cardTitle?: string;
    }) => {
      try {
        const client = getSupabaseServiceClient();
        let id = cardId;
        let resolvedTitle: string | undefined;

        if (!id) {
          if (!cardTitle) {
            return {
              success: false as const,
              message: "Provide either cardId or cardTitle.",
            };
          }
          const all = await listWorkItems(client);
          const needle = cardTitle.toLowerCase();
          const matches = all.filter((i) =>
            i.title.toLowerCase().includes(needle),
          );
          if (!matches.length) {
            return {
              success: false as const,
              message: `No card matched title "${cardTitle}".`,
            };
          }
          if (matches.length > 1) {
            return {
              success: false as const,
              message: `Multiple cards matched "${cardTitle}". Refusing to delete; pass cardId to disambiguate.`,
              matches: matches.map((m) => ({ id: m.id, title: m.title })),
            };
          }
          id = matches[0].id;
          resolvedTitle = matches[0].title;
        }

        await deleteWorkItem(client, id);

        return {
          success: true as const,
          deleted: { id, title: resolvedTitle },
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error ? error.message : "Error deleting card.",
        };
      }
    },
  });
}

const listKanbanCards = tool({
  description:
    "List cards on the shared Kanban board, optionally filtered by column name.",
  inputSchema: z.object({
    columnName: z.string().optional().describe("Filter by column name"),
    limit: z.number().optional().default(30).describe("Max cards to return"),
  }),
  execute: async ({ columnName, limit }: { columnName?: string; limit?: number }) => {
    try {
      const client = getSupabaseServiceClient();
      const [allItems, columns] = await Promise.all([
        listWorkItems(client),
        listColumns(client),
      ]);

      let filtered = allItems;
      if (columnName) {
        const col = columns.find(
          (c) => c.name.toLowerCase() === columnName.toLowerCase(),
        );
        if (!col) {
          return {
            success: false as const,
            message: `Column "${columnName}" not found. Available: ${columns.map((c) => c.name).join(", ")}`,
          };
        }
        filtered = allItems.filter((i) => i.columnId === col.id);
      }

      const capped = filtered.slice(0, limit ?? 30);
      const colMap = new Map(columns.map((c) => [c.id, c.name]));

      return {
        success: true as const,
        totalCards: filtered.length,
        columns: columns.map((c) => ({
          name: c.name,
          count: allItems.filter((i) => i.columnId === c.id).length,
        })),
        cards: capped.map((i) => ({
          id: i.id,
          title: i.title,
          description: i.description,
          column: colMap.get(i.columnId ?? "") ?? "Unknown",
          priority: i.priority,
          type: i.itemType,
          responsible: i.responsibleEmail,
          createdBy: i.userEmail,
          createdAt: i.createdAt,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error listing cards.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Goals tools (agent-driven goal management + Kanban links)
// ---------------------------------------------------------------------------

const GOAL_STATUS_ENUM = [
  "active",
  "completed",
  "missed",
  "paused",
  "archived",
] as const;
const GOAL_PRIORITY_ENUM = ["high", "medium", "low"] as const;
const GOAL_PERIOD_PRESETS = [
  "this_week",
  "next_week",
  "this_month",
  "next_month",
  "custom",
] as const;

async function resolveGoalRef(
  client: SupabaseClient,
  args: { goalId?: string; goalTitle?: string },
): Promise<
  | { ok: true; goal: Goal }
  | { ok: false; message: string; matches?: { id: string; title: string }[] }
> {
  if (args.goalId) {
    const all = await listGoals(client, { periodScope: "all" });
    const found = all.find((g) => g.id === args.goalId);
    if (!found) {
      return { ok: false, message: `Goal not found: ${args.goalId}` };
    }
    return { ok: true, goal: found };
  }
  if (args.goalTitle) {
    const all = await listGoals(client, { periodScope: "all" });
    const needle = args.goalTitle.toLowerCase();
    const matches = all.filter((g) => g.title.toLowerCase().includes(needle));
    if (matches.length === 0) {
      return { ok: false, message: `No goal matched title "${args.goalTitle}".` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `Multiple goals matched "${args.goalTitle}". Pass goalId.`,
        matches: matches.map((m) => ({ id: m.id, title: m.title })),
      };
    }
    return { ok: true, goal: matches[0] };
  }
  return { ok: false, message: "Provide either goalId or goalTitle." };
}

async function resolveWorkItemRef(
  client: SupabaseClient,
  args: { taskId?: string; taskTitle?: string },
): Promise<
  | { ok: true; workItem: { id: string; title: string } }
  | { ok: false; message: string; matches?: { id: string; title: string }[] }
> {
  const all = await listWorkItems(client);
  if (args.taskId) {
    const found = all.find((i) => i.id === args.taskId);
    if (!found) return { ok: false, message: `Task not found: ${args.taskId}` };
    return { ok: true, workItem: { id: found.id, title: found.title } };
  }
  if (args.taskTitle) {
    const needle = args.taskTitle.toLowerCase();
    const matches = all.filter((i) => i.title.toLowerCase().includes(needle));
    if (matches.length === 0) {
      return { ok: false, message: `No task matched title "${args.taskTitle}".` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `Multiple tasks matched "${args.taskTitle}". Pass taskId.`,
        matches: matches.map((m) => ({ id: m.id, title: m.title })),
      };
    }
    return { ok: true, workItem: matches[0] };
  }
  return { ok: false, message: "Provide either taskId or taskTitle." };
}

function resolvePeriod(
  preset: (typeof GOAL_PERIOD_PRESETS)[number] | undefined,
  periodStart: string | undefined,
  periodEnd: string | undefined,
): { start: string; end: string } | null {
  if (periodStart && periodEnd) return { start: periodStart, end: periodEnd };
  const effective = preset ?? "this_month";
  if (effective === "custom") return null;
  if (effective === "this_week") return currentWeekRange();
  if (effective === "next_week") {
    const next = new Date();
    next.setDate(next.getDate() + 7);
    return currentWeekRange(next);
  }
  if (effective === "this_month") return currentMonthRange();
  if (effective === "next_month") {
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    return currentMonthRange(next);
  }
  return null;
}

const listGoalsTool = tool({
  description:
    "List goals with optional filters (status, period scope, responsible). Default scope is 'current' (period contains today). Set includeLinks=true to include linked Kanban tasks per goal.",
  inputSchema: z.object({
    status: z.enum(GOAL_STATUS_ENUM).optional(),
    periodScope: z
      .enum(["current", "upcoming", "past", "all"])
      .optional()
      .describe("'current' = period contains today (default), 'all' = no period filter."),
    responsibleEmail: z.string().optional(),
    limit: z.number().optional().default(50),
    includeLinks: z.boolean().optional().default(false),
  }),
  execute: async ({
    status,
    periodScope,
    responsibleEmail,
    limit,
    includeLinks,
  }: {
    status?: (typeof GOAL_STATUS_ENUM)[number];
    periodScope?: "current" | "upcoming" | "past" | "all";
    responsibleEmail?: string;
    limit?: number;
    includeLinks?: boolean;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const goals = await listGoals(client, {
        status,
        periodScope: periodScope ?? "current",
        responsibleEmail,
        limit: limit ?? 50,
      });
      if (!includeLinks) {
        return { success: true as const, count: goals.length, goals };
      }
      const withLinks = await Promise.all(
        goals.map(async (g) => ({
          ...g,
          links: await listGoalLinks(client, g.id),
        })),
      );
      return { success: true as const, count: withLinks.length, goals: withLinks };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error listing goals.",
      };
    }
  },
});

function createCreateGoalTool(userEmail?: string) {
  return tool({
    description:
      "Create a new goal with target count and period. Optionally link existing Kanban cards (tasks) at creation — linked tasks in a 'done' stage auto-count toward the goal's target.",
    inputSchema: z.object({
      title: z.string().describe("Goal title"),
      description: z.string().optional(),
      unit: z
        .string()
        .optional()
        .describe("Unit of measurement (e.g. 'articles', 'leads', 'posts')."),
      targetCount: z.number().optional().default(1),
      period: z
        .enum(GOAL_PERIOD_PRESETS)
        .optional()
        .describe(
          "Quick preset for period. Defaults to 'this_month' when periodStart/periodEnd are not provided. Use 'custom' with explicit dates.",
        ),
      periodStart: z.string().optional().describe("YYYY-MM-DD. Overrides preset."),
      periodEnd: z.string().optional().describe("YYYY-MM-DD. Overrides preset."),
      priority: z.enum(GOAL_PRIORITY_ENUM).optional().default("medium"),
      status: z.enum(GOAL_STATUS_ENUM).optional().default("active"),
      responsibleEmail: z
        .string()
        .optional()
        .describe(
          "Email of the person responsible for this goal (e.g. 'gabriel@kodus.io').",
        ),
      projectRef: z.string().optional(),
      notes: z.string().optional(),
      funnelMetric: z
        .string()
        .optional()
        .describe(
          "Bind the goal to a funnel stage the funnel measures (visits, signups, icp, sh_instances, sh_trial, ob_contacts, ob_replies, conversations, meetings, opportunities, self_serve, closed). Progress is then written by the funnel sync, not by hand.",
        ),
      linkTaskIds: z
        .array(z.string())
        .optional()
        .describe("UUIDs of Kanban cards to link at creation."),
      linkTaskTitles: z
        .array(z.string())
        .optional()
        .describe(
          "Partial titles of Kanban cards to find and link. Each must resolve to exactly one card; ambiguous matches are skipped and reported.",
        ),
    }),
    execute: async ({
      title,
      description,
      unit,
      targetCount,
      period,
      periodStart,
      periodEnd,
      priority,
      status,
      responsibleEmail,
      projectRef,
      notes,
      funnelMetric,
      linkTaskIds,
      linkTaskTitles,
    }: {
      title: string;
      description?: string;
      unit?: string;
      targetCount?: number;
      period?: (typeof GOAL_PERIOD_PRESETS)[number];
      periodStart?: string;
      periodEnd?: string;
      priority?: (typeof GOAL_PRIORITY_ENUM)[number];
      status?: (typeof GOAL_STATUS_ENUM)[number];
      responsibleEmail?: string;
      projectRef?: string;
      notes?: string;
      funnelMetric?: string;
      linkTaskIds?: string[];
      linkTaskTitles?: string[];
    }) => {
      try {
        const client = getSupabaseServiceClient();
        const range = resolvePeriod(period, periodStart, periodEnd);
        if (!range) {
          return {
            success: false as const,
            message:
              "Provide either a period preset or both periodStart and periodEnd (YYYY-MM-DD).",
          };
        }

        const goal = await createGoal(client, {
          title,
          description: description ?? null,
          unit: unit ?? null,
          targetCount,
          periodStart: range.start,
          periodEnd: range.end,
          status,
          priority,
          responsibleEmail: responsibleEmail ?? null,
          projectRef: projectRef ?? null,
          notes: notes ?? null,
          funnelMetric: funnelMetric ?? null,
          createdByEmail: userEmail ?? "agent@kodus.io",
        });

        const linked: { id: string; title: string }[] = [];
        const failedLinks: { ref: string; reason: string }[] = [];

        for (const id of linkTaskIds ?? []) {
          const res = await resolveWorkItemRef(client, { taskId: id });
          if (!res.ok) {
            failedLinks.push({ ref: id, reason: res.message });
            continue;
          }
          await addGoalLink(client, goal.id, res.workItem.id, userEmail ?? null);
          linked.push(res.workItem);
        }
        for (const t of linkTaskTitles ?? []) {
          const res = await resolveWorkItemRef(client, { taskTitle: t });
          if (!res.ok) {
            failedLinks.push({ ref: t, reason: res.message });
            continue;
          }
          await addGoalLink(client, goal.id, res.workItem.id, userEmail ?? null);
          linked.push(res.workItem);
        }

        let finalGoal = goal;
        if (linked.length > 0) {
          const recalced = await recalculateGoalProgress(client, goal.id);
          if (recalced) finalGoal = recalced;
        }

        return {
          success: true as const,
          goal: finalGoal,
          linkedTasks: linked,
          ...(failedLinks.length ? { failedLinks } : {}),
        };
      } catch (error) {
        return {
          success: false as const,
          message: error instanceof Error ? error.message : "Error creating goal.",
        };
      }
    },
  });
}

const updateGoalTool = tool({
  description:
    "Update goal fields (title, description, target/current count, period, status, priority, responsible, notes). Identify by goalId (UUID, preferred) or partial title.",
  inputSchema: z.object({
    goalId: z.string().optional(),
    goalTitle: z.string().optional(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    unit: z.string().nullable().optional(),
    targetCount: z.number().optional(),
    currentCount: z.number().optional(),
    periodStart: z.string().optional().describe("YYYY-MM-DD"),
    periodEnd: z.string().optional().describe("YYYY-MM-DD"),
    status: z.enum(GOAL_STATUS_ENUM).optional(),
    priority: z.enum(GOAL_PRIORITY_ENUM).optional(),
    responsibleEmail: z.string().nullable().optional(),
    projectRef: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    funnelMetric: z
      .string()
      .nullable()
      .optional()
      .describe("Funnel stage id to bind (see createGoal); null unbinds."),
  }),
  execute: async ({
    goalId,
    goalTitle,
    ...updates
  }: {
    goalId?: string;
    goalTitle?: string;
    title?: string;
    description?: string | null;
    unit?: string | null;
    targetCount?: number;
    currentCount?: number;
    periodStart?: string;
    periodEnd?: string;
    status?: (typeof GOAL_STATUS_ENUM)[number];
    priority?: (typeof GOAL_PRIORITY_ENUM)[number];
    responsibleEmail?: string | null;
    projectRef?: string | null;
    notes?: string | null;
    funnelMetric?: string | null;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const ref = await resolveGoalRef(client, { goalId, goalTitle });
      if (!ref.ok) return { success: false as const, ...ref };

      const cleaned: Parameters<typeof updateGoal>[2] = {};
      for (const [k, v] of Object.entries(updates)) {
        if (typeof v !== "undefined") {
          (cleaned as Record<string, unknown>)[k] = v;
        }
      }
      if (!Object.keys(cleaned).length) {
        return {
          success: false as const,
          message: "No fields to update. Provide at least one.",
        };
      }

      const goal = await updateGoal(client, ref.goal.id, cleaned);
      return { success: true as const, goal };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error updating goal.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Bets: what we run to move a goal. Not tasks.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI visibility: buyer prompts asked weekly to the assistants
// ---------------------------------------------------------------------------

const listAiPromptsTool = tool({
  description:
    "List the buyer prompts tracked for AI visibility (asked weekly to ChatGPT, Perplexity, Gemini, Claude via DataForSEO), with the latest answer per assistant: whether Kodus was named, its list position, competitors named and pages cited.",
  inputSchema: z.object({
    runOn: z.string().optional().describe("YYYY-MM-DD of a past run; default latest."),
  }),
  execute: async ({ runOn }: { runOn?: string }) => {
    try {
      const summary = await getVisibilitySummary(getSupabaseServiceClient(), { runOn });
      return {
        success: true as const,
        runOn: summary.runOn,
        weekday: summary.settings.weekday,
        engines: summary.engines,
        overallShare: summary.overallShare,
        prompts: summary.prompts.map(({ prompt, runs }) => ({
          id: prompt.id,
          prompt: prompt.prompt,
          language: prompt.language,
          tags: prompt.tags,
          active: prompt.active,
          results: Object.values(runs).map((r) => ({
            engine: ENGINE_LABEL[r.engine],
            mentioned: r.mentioned,
            position: r.position,
            listSize: r.listSize,
            brandCited: r.brandCited,
            competitors: r.competitors,
            citedDomains: r.citedDomains,
            error: r.error,
          })),
        })),
        sourcesWithoutKodus: summary.domains.filter((d) => d.runsWithoutBrand > 0).slice(0, 15),
        competitors: summary.competitors.slice(0, 15),
        totalCostUsd: summary.totalCostUsd,
      };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const createAiPromptTool = tool({
  description:
    "Add a buyer prompt to the weekly AI visibility run. Write it the way a buyer would ask an assistant (max 500 characters). It is asked on the next scheduled run, or immediately with runAiVisibility.",
  inputSchema: z.object({
    prompt: z.string().min(5).max(500),
    language: z.string().optional().describe("'en' (default) or 'pt'"),
    tags: z.array(z.string()).optional(),
  }),
  execute: async ({ prompt, language, tags }: { prompt: string; language?: string; tags?: string[] }) => {
    try {
      const created = await createAiPrompt(getSupabaseServiceClient(), { prompt, language, tags });
      return { success: true as const, prompt: created };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const runAiVisibilityTool = tool({
  description:
    "Ask the assistants the tracked prompts now (outside the weekly schedule). Costs money per prompt per assistant (about US$ 0.006 on Perplexity, US$ 0.09 on ChatGPT), so prefer promptIds for a single prompt. Prompts already asked today are skipped unless force is true.",
  inputSchema: z.object({
    promptIds: z.array(z.string()).optional(),
    engines: z.array(z.enum(AI_ENGINES)).optional().describe("Subset of assistants; default the configured ones."),
    force: z.boolean().optional().default(false),
  }),
  execute: async ({ promptIds, engines, force }: { promptIds?: string[]; engines?: AiEngine[]; force?: boolean }) => {
    try {
      const client = getSupabaseServiceClient();
      // A subset keeps the model configured for that assistant; an assistant
      // not in the settings gets DataForSEO's default model.
      let engineConfigs: EngineConfig[] | undefined;
      if (engines?.length) {
        const configured = (await getAiVisibilitySettings(client)).engines;
        engineConfigs = engines.map((e) => configured.find((c) => c.engine === e) ?? { engine: e, model: DEFAULT_MODELS[e] });
      }
      const summary = await runAiVisibility(client, { promptIds, force, engines: engineConfigs });
      return { success: true as const, summary };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// Funnel: the measured funnel for a month or any date range
// ---------------------------------------------------------------------------

const getFunnelTool = tool({
  description:
    "The measured growth funnel for a month ('YYYY-MM') or a date range ('YYYY-MM-DD..YYYY-MM-DD'): every stage with its value, definition, source and drill-down rows, the conversion rates against market bands, and the goals bound to each stage. Same numbers as the /funnel page. Read-only; targets come from goals.",
  inputSchema: z.object({
    period: z.string().optional().describe("'YYYY-MM' or 'YYYY-MM-DD..YYYY-MM-DD'; default current month."),
    includeRows: z.boolean().optional().default(false).describe("Include drill-down rows per stage (can be large)."),
  }),
  execute: async ({ period, includeRows }: { period?: string; includeRows?: boolean }) => {
    try {
      const spec = period && (/^\d{4}-\d{2}$/.test(period) || /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(period)) ? period : new Date().toISOString().slice(0, 7);
      const f = await fetchFunnel(getSupabaseServiceClient(), spec);
      return {
        success: true as const,
        period: { spec, start: f.periodStart, end: f.periodEnd, elapsedShare: f.elapsed },
        metrics: FUNNEL_METRICS,
        stages: Object.values(f.nodes).map((n) => ({
          id: n.id,
          title: n.title,
          value: n.value,
          display: n.display,
          definition: n.definition,
          source: n.source,
          goal: n.goal ?? null,
          bets: n.bets ?? [],
          ...(includeRows ? { columns: n.columns, rows: n.rows.slice(0, 200) } : { rowCount: n.rows.length }),
        })),
        rates: f.rates,
        facts: f.facts,
        errors: f.errors,
      };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const updateBetTool = tool({
  description: "Edit a bet's text: title, hypothesis, action, proving metric, decision date (YYYY-MM-DD) or notes. Use decideBet to change status.",
  inputSchema: z.object({
    betId: z.string(),
    title: z.string().optional(),
    hypothesis: z.string().optional(),
    action: z.string().optional(),
    metric: z.string().optional(),
    decisionAt: z.string().optional(),
    notes: z.string().optional(),
  }),
  execute: async ({ betId, ...patch }: { betId: string; title?: string; hypothesis?: string; action?: string; metric?: string; decisionAt?: string; notes?: string }) => {
    try {
      const bet = await updateBet(getSupabaseServiceClient(), betId, patch);
      return { success: true as const, bet };
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : "Error updating bet." };
    }
  },
});

const deleteBetTool = tool({
  description: "Delete a bet. Prefer decideBet (lost / operation) so the verdict stays on record; delete only a bet created by mistake.",
  inputSchema: z.object({ betId: z.string() }),
  execute: async ({ betId }: { betId: string }) => {
    try {
      await deleteBet(getSupabaseServiceClient(), betId);
      return { success: true as const };
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : "Error deleting bet." };
    }
  },
});

const updateAiPromptTool = tool({
  description: "Edit a tracked AI visibility prompt: text (max 500 chars), language, tags, or pause/resume it with active.",
  inputSchema: z.object({
    promptId: z.string(),
    prompt: z.string().optional(),
    language: z.string().optional(),
    tags: z.array(z.string()).optional(),
    active: z.boolean().optional(),
  }),
  execute: async ({ promptId, ...patch }: { promptId: string; prompt?: string; language?: string; tags?: string[]; active?: boolean }) => {
    try {
      const prompt = await updateAiPrompt(getSupabaseServiceClient(), promptId, patch);
      return { success: true as const, prompt };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const deleteAiPromptTool = tool({
  description: "Delete a tracked AI visibility prompt and its run history. To keep history but stop asking, use updateAiPrompt with active=false.",
  inputSchema: z.object({ promptId: z.string() }),
  execute: async ({ promptId }: { promptId: string }) => {
    try {
      await deleteAiPrompt(getSupabaseServiceClient(), promptId);
      return { success: true as const };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const getAiVisibilitySettingsTool = tool({
  description: "AI visibility schedule and assistants: weekday of the weekly run (0 = Sunday, UTC), assistants with their model, brand and competitor terms, last run date.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const settings = await getAiVisibilitySettings(getSupabaseServiceClient());
      return { success: true as const, settings: { ...settings, weekdayLabel: WEEKDAY_LABELS[settings.weekday] }, availableEngines: AI_ENGINES, defaultModels: DEFAULT_MODELS };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const updateAiVisibilitySettingsTool = tool({
  description:
    "Change the AI visibility schedule or assistants: weekday (0 = Sunday .. 6 = Saturday, UTC), engines (list of {engine, model}; engine one of perplexity, chat_gpt, gemini, claude; model optional, defaults per engine), brand terms, competitor terms. Takes effect on the next run, no redeploy.",
  inputSchema: z.object({
    weekday: z.number().int().min(0).max(6).optional(),
    engines: z.array(z.object({ engine: z.enum(AI_ENGINES), model: z.string().optional() })).optional(),
    brandTerms: z.array(z.string()).optional(),
    competitorTerms: z.array(z.string()).optional(),
  }),
  execute: async ({ weekday, engines, brandTerms, competitorTerms }: { weekday?: number; engines?: Array<{ engine: AiEngine; model?: string }>; brandTerms?: string[]; competitorTerms?: string[] }) => {
    try {
      const settings = await updateAiVisibilitySettings(getSupabaseServiceClient(), {
        ...(weekday != null ? { weekday } : {}),
        ...(engines ? { engines: engines.map((e) => ({ engine: e.engine, model: e.model ?? DEFAULT_MODELS[e.engine] })) } : {}),
        ...(brandTerms ? { brandTerms } : {}),
        ...(competitorTerms ? { competitorTerms } : {}),
      });
      return { success: true as const, settings: { ...settings, weekdayLabel: WEEKDAY_LABELS[settings.weekday] } };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const listBetsTool = tool({
  description:
    "List bets (hypothesis + action + proving metric + decision date) running on goals. Filter by goal (id or partial title) or status: queued, active, won, lost, operation. At most 3 bets are active at a time.",
  inputSchema: z.object({
    goalId: z.string().optional(),
    goalTitle: z.string().optional(),
    status: z.enum(["queued", "active", "won", "lost", "operation"]).optional(),
  }),
  execute: async ({ goalId, goalTitle, status }: { goalId?: string; goalTitle?: string; status?: BetStatus }) => {
    try {
      const client = getSupabaseServiceClient();
      let gid = goalId;
      if (!gid && goalTitle) {
        const ref = await resolveGoalRef(client, { goalTitle });
        if (!ref.ok) return { success: false as const, ...ref };
        gid = ref.goal.id;
      }
      const bets = await listBets(client, { goalId: gid, status });
      return { success: true as const, count: bets.length, bets };
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : "Error listing bets." };
    }
  },
});

const createBetTool = tool({
  description:
    "Create a bet on a goal. Requires all four fields: hypothesis (if we do X, metric Y moves because...), action (what exactly will be done), metric (the number that proves it, with threshold), decisionAt (YYYY-MM-DD when the verdict is due). Refused as active when 3 bets are already active; pass status 'queued' to park it.",
  inputSchema: z.object({
    goalId: z.string().optional(),
    goalTitle: z.string().optional(),
    title: z.string(),
    hypothesis: z.string(),
    action: z.string(),
    metric: z.string(),
    decisionAt: z.string().describe("YYYY-MM-DD"),
    status: z.enum(["queued", "active"]).optional(),
    notes: z.string().optional(),
    user_email: z.string().optional(),
  }),
  execute: async ({
    goalId,
    goalTitle,
    title,
    hypothesis,
    action,
    metric,
    decisionAt,
    status,
    notes,
    user_email,
  }: {
    goalId?: string;
    goalTitle?: string;
    title: string;
    hypothesis: string;
    action: string;
    metric: string;
    decisionAt: string;
    status?: "queued" | "active";
    notes?: string;
    user_email?: string;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const ref = await resolveGoalRef(client, { goalId, goalTitle });
      if (!ref.ok) return { success: false as const, ...ref };
      const bet = await createBet(client, {
        goalId: ref.goal.id,
        title,
        hypothesis,
        action,
        metric,
        decisionAt,
        status,
        notes: notes ?? null,
        createdByEmail: user_email ?? "agent@kodus.io",
      });
      return { success: true as const, bet };
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : "Error creating bet." };
    }
  },
});

const decideBetTool = tool({
  description:
    "Decide or move a bet: status won, lost, operation (became routine work), active (start a queued bet; refused when 3 are active) or queued. Give a one-line verdict when deciding won or lost.",
  inputSchema: z.object({
    betId: z.string(),
    status: z.enum(["queued", "active", "won", "lost", "operation"]),
    verdict: z.string().optional(),
    notes: z.string().optional(),
  }),
  execute: async ({ betId, status, verdict, notes }: { betId: string; status: BetStatus; verdict?: string; notes?: string }) => {
    try {
      const client = getSupabaseServiceClient();
      const bet = await updateBet(client, betId, {
        status,
        ...(verdict !== undefined ? { verdict } : {}),
        ...(notes !== undefined ? { notes } : {}),
      });
      return { success: true as const, bet };
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : "Error updating bet." };
    }
  },
});

const deleteGoalTool = tool({
  description:
    "Delete a goal permanently (also removes its goal_links). Identify by goalId (UUID) or partial title — if multiple goals match the title, returns an error listing them. Destructive, no undo.",
  inputSchema: z.object({
    goalId: z.string().optional(),
    goalTitle: z.string().optional(),
  }),
  execute: async ({
    goalId,
    goalTitle,
  }: {
    goalId?: string;
    goalTitle?: string;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const ref = await resolveGoalRef(client, { goalId, goalTitle });
      if (!ref.ok) return { success: false as const, ...ref };
      await deleteGoal(client, ref.goal.id);
      return {
        success: true as const,
        deleted: { id: ref.goal.id, title: ref.goal.title },
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error deleting goal.",
      };
    }
  },
});

const incrementGoalProgressTool = tool({
  description:
    "Manually adjust a goal's current_count by delta (e.g. +1 to mark one more done, -1 to undo). Auto-flips status to 'completed' when target is reached. Note: goals with linked tasks recompute from links; prefer linkGoalToTask for auto-progress.",
  inputSchema: z.object({
    goalId: z.string().optional(),
    goalTitle: z.string().optional(),
    delta: z.number().describe("Integer delta. Use 1 for +1, -1 to undo."),
  }),
  execute: async ({
    goalId,
    goalTitle,
    delta,
  }: {
    goalId?: string;
    goalTitle?: string;
    delta: number;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const ref = await resolveGoalRef(client, { goalId, goalTitle });
      if (!ref.ok) return { success: false as const, ...ref };
      const goal = await incrementGoalProgress(client, ref.goal.id, delta);
      return { success: true as const, goal };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error updating progress.",
      };
    }
  },
});

function createLinkGoalToTaskTool(userEmail?: string) {
  return tool({
    description:
      "Link a Kanban card (task) to a goal for auto-progress. Each linked task in a 'done' stage (published/done/completed/shipped/live) counts toward the goal's target. Identify goal and task each by id (UUID) or partial title.",
    inputSchema: z.object({
      goalId: z.string().optional(),
      goalTitle: z.string().optional(),
      taskId: z.string().optional(),
      taskTitle: z.string().optional(),
    }),
    execute: async ({
      goalId,
      goalTitle,
      taskId,
      taskTitle,
    }: {
      goalId?: string;
      goalTitle?: string;
      taskId?: string;
      taskTitle?: string;
    }) => {
      try {
        const client = getSupabaseServiceClient();
        const goalRef = await resolveGoalRef(client, { goalId, goalTitle });
        if (!goalRef.ok) return { success: false as const, ...goalRef };
        const taskRef = await resolveWorkItemRef(client, { taskId, taskTitle });
        if (!taskRef.ok) return { success: false as const, ...taskRef };

        await addGoalLink(
          client,
          goalRef.goal.id,
          taskRef.workItem.id,
          userEmail ?? null,
        );
        const recalced = await recalculateGoalProgress(client, goalRef.goal.id);

        return {
          success: true as const,
          linked: {
            goal: { id: goalRef.goal.id, title: goalRef.goal.title },
            task: taskRef.workItem,
          },
          goal: recalced ?? goalRef.goal,
        };
      } catch (error) {
        return {
          success: false as const,
          message: error instanceof Error ? error.message : "Error linking goal.",
        };
      }
    },
  });
}

const unlinkGoalFromTaskTool = tool({
  description:
    "Remove the link between a goal and a Kanban card. Recomputes the goal's progress after unlinking.",
  inputSchema: z.object({
    goalId: z.string().optional(),
    goalTitle: z.string().optional(),
    taskId: z.string().optional(),
    taskTitle: z.string().optional(),
  }),
  execute: async ({
    goalId,
    goalTitle,
    taskId,
    taskTitle,
  }: {
    goalId?: string;
    goalTitle?: string;
    taskId?: string;
    taskTitle?: string;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const goalRef = await resolveGoalRef(client, { goalId, goalTitle });
      if (!goalRef.ok) return { success: false as const, ...goalRef };
      const taskRef = await resolveWorkItemRef(client, { taskId, taskTitle });
      if (!taskRef.ok) return { success: false as const, ...taskRef };

      await removeGoalLink(client, goalRef.goal.id, taskRef.workItem.id);
      const recalced = await recalculateGoalProgress(client, goalRef.goal.id);

      return {
        success: true as const,
        unlinked: {
          goal: { id: goalRef.goal.id, title: goalRef.goal.title },
          task: taskRef.workItem,
        },
        goal: recalced ?? goalRef.goal,
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error unlinking goal.",
      };
    }
  },
});

const listGoalLinksTool = tool({
  description:
    "List Kanban cards linked to a specific goal, including each card's stage, priority, and whether it currently counts as 'done' for goal progress.",
  inputSchema: z.object({
    goalId: z.string().optional(),
    goalTitle: z.string().optional(),
  }),
  execute: async ({
    goalId,
    goalTitle,
  }: {
    goalId?: string;
    goalTitle?: string;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const ref = await resolveGoalRef(client, { goalId, goalTitle });
      if (!ref.ok) return { success: false as const, ...ref };
      const links = await listGoalLinks(client, ref.goal.id);
      return {
        success: true as const,
        goal: {
          id: ref.goal.id,
          title: ref.goal.title,
          currentCount: ref.goal.currentCount,
          targetCount: ref.goal.targetCount,
          status: ref.goal.status,
        },
        links,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Error listing links.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Social monitoring (read-only)
// ---------------------------------------------------------------------------

const SOCIAL_PLATFORMS = [
  "reddit",
  "twitter",
  "linkedin",
  "hackernews",
  "web",
  "github",
] as const;
const SOCIAL_RELEVANCES = ["high", "medium", "low"] as const;
const SOCIAL_INTENTS = [
  "asking_help",
  "complaining",
  "comparing_tools",
  "discussing",
  "sharing_experience",
  "backlink_opportunity",
  "competitor_listicle",
] as const;
const SOCIAL_STATUSES = [
  "new",
  "contacted",
  "replied",
  "dismissed",
] as const;

const listSocialMentions = tool({
  description:
    "List qualified social mentions captured by the social-monitor pipeline (Reddit, Twitter, LinkedIn, Hacker News, generic Web, GitHub awesome lists). Supports filtering by platform, relevance, status, intent, and a published-at date range. Returns the matching rows plus aggregate stats. Read-only.",
  inputSchema: z.object({
    platform: z
      .enum(SOCIAL_PLATFORMS)
      .optional()
      .describe("Restrict to a single source platform."),
    relevance: z
      .enum(SOCIAL_RELEVANCES)
      .optional()
      .describe("Restrict to mentions of a given relevance tier."),
    status: z
      .enum(SOCIAL_STATUSES)
      .optional()
      .describe(
        "Workflow status. 'new' = untouched, 'contacted' = outreach sent, 'replied' = engaged, 'dismissed' = ignored.",
      ),
    intent: z
      .enum(SOCIAL_INTENTS)
      .optional()
      .describe(
        "Intent classification. 'backlink_opportunity' and 'competitor_listicle' are the most actionable for outreach.",
      ),
    dateFrom: z
      .string()
      .optional()
      .describe(
        "Inclusive lower bound on published_at (ISO 8601 date or timestamp, e.g. '2026-05-01' or '2026-05-01T00:00:00Z').",
      ),
    dateTo: z
      .string()
      .optional()
      .describe(
        "Inclusive upper bound on published_at (ISO 8601 date or timestamp).",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe("Max mentions to return (1-200, default 50)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Pagination offset (default 0)."),
  }),
  execute: async ({
    platform,
    relevance,
    status,
    intent,
    dateFrom,
    dateTo,
    limit,
    offset,
  }: {
    platform?: (typeof SOCIAL_PLATFORMS)[number];
    relevance?: (typeof SOCIAL_RELEVANCES)[number];
    status?: (typeof SOCIAL_STATUSES)[number];
    intent?: (typeof SOCIAL_INTENTS)[number];
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const filters: MentionFilters = {
        ...(platform ? { platform } : {}),
        ...(relevance ? { relevance } : {}),
        ...(status ? { status } : {}),
        ...(intent ? { intent } : {}),
        ...(dateFrom ? { dateFrom } : {}),
        // For dateTo, expand a bare date ("2026-05-16") to end-of-day so it
        // covers everything published on that calendar day. Mirrors the API
        // route behavior.
        ...(dateTo
          ? {
              dateTo: /^\d{4}-\d{2}-\d{2}$/.test(dateTo)
                ? `${dateTo}T23:59:59.999Z`
                : dateTo,
            }
          : {}),
        limit: limit ?? 50,
        offset: offset ?? 0,
      };

      const [mentions, stats] = await Promise.all([
        listMentions(client, filters),
        getMentionStats(client),
      ]);

      return {
        success: true as const,
        count: mentions.length,
        // Project to a leaner shape — full content can be huge and a tool
        // result that ships 50 raw posts blows the context budget.
        mentions: mentions.map((m) => ({
          id: m.id,
          platform: m.platform,
          url: m.url,
          title: m.title,
          author: m.author,
          publishedAt: m.published_at,
          relevance: m.relevance,
          intent: m.intent,
          status: m.status,
          suggestedApproach: m.suggested_approach,
          keywordsMatched: m.keywords_matched,
          contentPreview:
            m.content.length > 500 ? `${m.content.slice(0, 500)}...` : m.content,
        })),
        stats: {
          total: stats.total,
          byPlatform: stats.byPlatform,
          byStatus: stats.byStatus,
          byIntent: stats.byIntent,
        },
        nextOffset:
          mentions.length === (limit ?? 50)
            ? (offset ?? 0) + mentions.length
            : null,
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Error listing mentions.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Company CRM tools
// ---------------------------------------------------------------------------

export const listCrmCompanies = tool({
  description:
    "List/filter companies in the Company CRM. Filter by status, owner, outbound tier (t0=open decision window, t1=connected git recently, t2=signed up never connected, t3=older base, customer=paying), prep gate (only 'ready' accounts may be enrolled), search text, or only accounts that are idle past their status SLA (stale_only). Every row carries its trigger — the reason behind the tier, which is what decides the message — and in_sequences, the cadences the account is in right now (empty = free to enrol; non-empty is why an enroll call would skip it).",
  inputSchema: z.object({
    status: z
      .enum(COMPANY_STATUSES as unknown as [string, ...string[]])
      .optional()
      .describe("Filter by pipeline status"),
    tier: z
      .enum(["t0", "t1", "t2", "t3", "customer"])
      .optional()
      .describe("Filter by outbound tier from product signals"),
    // Enum, not a free string: the set is machine-written by classify.ts, so a
    // typo has no chance of matching. As a string it would reach
    // .eq("trigger", …) and come back count: 0 — a caller that asked for
    // "trial-expired" would read that as "no accounts in that state" rather
    // than "that state does not exist".
    trigger: z
      .enum(CRM_TIER_TRIGGERS as unknown as [string, ...string[]])
      .optional()
      .describe("Filter by the reason behind the tier"),
    prep_status: z
      .enum(COMPANY_PREP_VALUES as unknown as [string, ...string[]])
      .optional()
      .describe(
        "Filter by review gate: not_started | enriched | ready | parked. Only 'ready' accounts may be enrolled in a sequence.",
      ),
    deployment: z
      .enum(["cloud", "self_hosted"])
      .optional()
      .describe("Filter by how the account runs Kodus"),
    channel: z
      .enum(["manual", "webhook", "agent", "research", "pipeline", "social", "sequence", "product"])
      .optional()
      .describe("Filter by acquisition channel (company source)"),
    owner_email: z.string().optional().describe("Filter by responsible owner email"),
    stale_only: z
      .boolean()
      .optional()
      .describe("Only companies idle past their status SLA (need attention)"),
    search: z.string().optional().describe("Search name, domain, org id, industry, notes"),
    limit: z.number().optional().describe("Max rows (default 50)"),
  }),
  execute: async ({
    status,
    tier,
    trigger,
    prep_status,
    deployment,
    channel,
    owner_email,
    stale_only,
    search,
    limit,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const companies = await listCompanies(client, {
        status: status as CompanyStatus | undefined,
        tier,
        trigger,
        prepStatus: prep_status as CompanyPrep | undefined,
        deployment,
        source: channel,
        ownerEmail: owner_email,
        staleOnly: stale_only,
        search,
        limit: limit ?? 50,
      });
      return {
        success: true as const,
        count: companies.length,
        companies: companies.map((c) => ({
          id: c.id,
          name: c.name,
          domain: c.domain,
          org_id: c.orgId,
          status: c.status,
          priority: c.priority,
          tier: c.tier,
          // Tier says when to touch the account, trigger says what to say. A
          // caller that can only see the tier is picking a queue position with
          // no idea which message belongs to it.
          trigger: c.trigger,
          prep_status: c.prepStatus,
          // Which cadences the account is in right now (active or paused).
          // Empty means free to enrol; a non-empty list is why an enroll call
          // would report this account as skipped. Without it a caller routing
          // accounts into sequences is picking blind and reading the refusal
          // afterwards.
          in_sequences: c.sequences.map((s) => ({
            sequence_id: s.sequenceId,
            name: s.sequenceName,
            status: s.status,
            step_position: s.stepPosition,
            next_run_at: s.nextRunAt,
          })),
          deployment: c.deployment,
          channel: c.source,
          owner_email: c.ownerEmail,
          dev_count: c.devCount,
          idle_days: c.idleDays,
          is_stale: c.isStale,
          last_activity_at: c.lastActivityAt,
          last_outreach_at: c.lastOutreachAt,
          last_outreach_channel: c.lastOutreachChannel ?? null,
          outreach_sent_count: c.outreachSentCount,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to list companies",
      };
    }
  },
});

export const enrichCrmCompanyContacts = tool({
  description:
    "Find the people behind a CRM account (name, job title, LinkedIn) and merge them into its contacts. Accounts created from product signups carry only whoever signed up, usually an email with no title and no LinkedIn, which leaves LinkedIn sequence steps with no profile to open. Billed per call by the data provider, so run it for accounts you are about to work, not in bulk. Never overwrites existing contact data: it fills gaps and adds people who were missing.",
  inputSchema: z.object({
    company_id: z.string().describe("CRM company id"),
    max_people: z
      .number()
      .optional()
      .describe("How many people to look for, 1 to 10. Defaults to 5."),
  }),
  execute: async ({ company_id, max_people }) => {
    try {
      const { enrichCompanyContacts } = await import("@/lib/crm-enrich");
      const result = await enrichCompanyContacts(
        getSupabaseServiceClient(),
        company_id,
        { maxPeople: max_people },
      );
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Failed to enrich contacts",
      };
    }
  },
});

export const getCrmCompany = tool({
  description:
    "Get a single CRM company with its contacts, recent comments, activity timeline, custom properties, field definitions, and — when linked to a product org_id — real product usage signals from BigQuery.",
  inputSchema: z.object({
    id: z.string().describe("Company id"),
  }),
  execute: async ({ id }) => {
    try {
      const client = getSupabaseServiceClient();
      const { listFieldDefs } = await import("@/lib/crm-fields");
      const company = await getCompany(client, id);
      if (!company) {
        return { success: false as const, message: "Company not found" };
      }
      const [contacts, comments, activities, fieldDefs, seqByCompany] =
        await Promise.all([
          listContacts(client, id),
          listComments(client, id),
          listActivities(client, id, 20),
          listFieldDefs(client),
          listCompanySequences(client, [id]),
        ]);
      let signals = null;
      if (company.orgId) {
        signals = await getProductSignals(company.orgId).catch(() => null);
      }
      return {
        success: true as const,
        company: {
          id: company.id,
          name: company.name,
          domain: company.domain,
          org_id: company.orgId,
          status: company.status,
          priority: company.priority,
          // The outbound state of the account: which queue it sits in (tier),
          // why it is there (trigger), and whether it has been vetted enough
          // to work at all (prep_status — only 'ready' may be enrolled).
          tier: company.tier,
          trigger: company.trigger,
          prep_status: company.prepStatus,
          // Live cadences (active or paused). Empty = free to enrol.
          in_sequences: (seqByCompany.get(id) ?? []).map((s) => ({
            sequence_id: s.sequenceId,
            name: s.sequenceName,
            status: s.status,
            step_position: s.stepPosition,
            next_run_at: s.nextRunAt,
          })),
          owner_email: company.ownerEmail,
          industry: company.industry,
          size: company.size,
          dev_count: company.devCount,
          country: company.country,
          arr: company.arr,
          notes: company.notes,
          properties: company.properties,
          last_activity_at: company.lastActivityAt,
          last_outreach_at: company.lastOutreachAt,
          last_outreach_channel: company.lastOutreachChannel ?? null,
          outreach_sent_count: company.outreachSentCount,
          // icp_gate reason, dev_count_source, employee_count — how the sweep
          // decided this account was worth creating.
          enrichment: company.enrichment,
        },
        field_defs: fieldDefs.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          options: f.options,
        })),
        // `id` is what updateCrmContact/archiveCrmContact take, and this is the
        // only tool that hands one out — without it those two are unreachable.
        // linkedin and is_primary are here for the same reason: they are
        // writable now, and gap-filling needs to see which are already set.
        contacts: contacts.map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email,
          role: c.role,
          linkedin: c.linkedin,
          is_primary: c.isPrimary,
        })),
        comments: comments.slice(0, 10).map((c) => ({
          author: c.authorEmail,
          body: c.bodyMd,
          created_at: c.createdAt,
        })),
        activities: activities.map((a) => ({
          kind: a.kind,
          summary: a.summary,
          created_at: a.createdAt,
        })),
        product_signals: signals,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to get company",
      };
    }
  },
});

export const createCrmCompany = tool({
  description:
    "Create a company in the Company CRM. Link it to a product org with org_id when known.",
  inputSchema: z.object({
    name: z.string().describe("Company name (required)"),
    domain: z.string().optional().describe("Primary domain, e.g. acme.com"),
    org_id: z.string().optional().describe("Product organization uuid to link usage signals"),
    status: z.enum(COMPANY_STATUSES as unknown as [string, ...string[]]).optional(),
    priority: z.enum(COMPANY_PRIORITIES as unknown as [string, ...string[]]).optional(),
    owner_email: z.string().optional().describe("Responsible owner email"),
    industry: z.string().optional(),
    dev_count: z.number().optional().describe("Number of developers at the company"),
    notes: z.string().optional(),
    user_email: z.string().optional().describe("Acting user's email (recorded as creator)"),
  }),
  execute: async ({
    name,
    domain,
    org_id,
    status,
    priority,
    owner_email,
    industry,
    dev_count,
    notes,
    user_email,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const company = await createCompany(client, {
        name,
        domain,
        orgId: org_id,
        status: status as CompanyStatus | undefined,
        priority: priority as CompanyPriority | undefined,
        ownerEmail: owner_email,
        industry,
        devCount: dev_count,
        notes,
        source: "agent",
        createdByEmail: user_email,
      });
      return { success: true as const, id: company.id, company };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to create company",
      };
    }
  },
});

export const updateCrmCompany = tool({
  description:
    "Update a CRM company — status, priority, owner, dev_count, arr (contract value per year, BRL), org link, industry, notes, or custom properties (key → value; null clears a key). List field defs with listCrmFields.",
  inputSchema: z.object({
    id: z.string().describe("Company id"),
    status: z.enum(COMPANY_STATUSES as unknown as [string, ...string[]]).optional(),
    priority: z.enum(COMPANY_PRIORITIES as unknown as [string, ...string[]]).optional(),
    prep_status: z
      .enum(COMPANY_PREP_VALUES as unknown as [string, ...string[]])
      .optional()
      .describe(
        "Review gate, separate from status: raw (untouched) → enriched (lookup ran) → ready (vetted, may be enrolled) or parked (set aside). Only 'ready' accounts can enter a sequence.",
      ),
    owner_email: z.string().nullable().optional(),
    org_id: z.string().nullable().optional(),
    deployment: z
      .enum(["cloud", "self_hosted"])
      .nullable()
      .optional()
      .describe("How the account runs Kodus; null clears it"),
    industry: z.string().nullable().optional(),
    dev_count: z.number().nullable().optional(),
    arr: z
      .number()
      .nullable()
      .optional()
      .describe("Annual contract value in BRL. The funnel sums it when the account becomes a customer."),
    notes: z.string().nullable().optional(),
    properties: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional()
      .describe(
        "Custom field values by key (e.g. { self_hosted: true }). null removes a key. Select fields store option id.",
      ),
    user_email: z.string().optional().describe("Acting user's email (recorded as actor)"),
  }),
  execute: async ({
    id,
    status,
    priority,
    prep_status,
    owner_email,
    org_id,
    deployment,
    industry,
    dev_count,
    arr,
    notes,
    properties,
    user_email,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const company = await updateCompany(
        client,
        id,
        {
          status: status as CompanyStatus | undefined,
          priority: priority as CompanyPriority | undefined,
          ...(prep_status !== undefined
            ? { prepStatus: prep_status as CompanyPrep }
            : {}),
          // updateCompany decides what to write with `"key" in updates`, not
          // with a truthiness check, so a key that is present-but-undefined is
          // a request to clear the column. Omitting a field here has to mean
          // "leave it alone" — the agent routinely sends a partial patch (fix
          // just the notes), and unconditional keys turned that into a wipe of
          // owner, industry and dev_count with no timeline entry for two of
          // the three.
          ...(owner_email !== undefined ? { ownerEmail: owner_email } : {}),
          ...(org_id !== undefined ? { orgId: org_id } : {}),
          ...(deployment !== undefined ? { deployment } : {}),
          ...(industry !== undefined ? { industry } : {}),
          ...(dev_count !== undefined ? { devCount: dev_count } : {}),
          ...(arr !== undefined ? { arr } : {}),
          ...(notes !== undefined ? { notes } : {}),
          properties,
        },
        user_email,
      );
      return {
        success: true as const,
        company: {
          id: company.id,
          name: company.name,
          status: company.status,
          properties: company.properties,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to update company",
      };
    }
  },
});

export const archiveCrmCompany = tool({
  description:
    "Exclude an account from the CRM — a duplicate, a dead deal, a company that asked out. Archives rather than hard-deletes, on purpose: a deleted account is recreated by the next product-signals sweep (it looks the domain up, finds nothing, and re-adds it), while an archived one is still found and left alone. The account disappears from listCrmCompanies and getCrmCompany, but its contacts, comments and timeline ride along on the same row so the exclusion stays reviewable and restoreCrmCompany is a real undo. Use restoreCrmCompany to bring it back.",
  inputSchema: z.object({
    id: z.string().describe("Company id (from listCrmCompanies / getCrmCompany)"),
    user_email: z
      .string()
      .optional()
      .describe("Acting user's email (recorded as actor on the timeline)"),
  }),
  execute: async ({ id, user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const company = await archiveCompany(client, id, user_email);
      return {
        success: true as const,
        id: company.id,
        name: company.name,
        archived: true as const,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to archive company",
      };
    }
  },
});

export const restoreCrmCompany = tool({
  description:
    "Undo an account exclusion made with archiveCrmCompany: the account returns to every list and the product-signals sweep resumes maintaining its tier. Its contacts, comments and timeline were never removed, so this is a restore rather than a re-import.",
  inputSchema: z.object({
    id: z.string().describe("Company id of an archived account"),
    user_email: z
      .string()
      .optional()
      .describe("Acting user's email (recorded as actor on the timeline)"),
  }),
  execute: async ({ id, user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const company = await restoreCompany(client, id, user_email);
      return {
        success: true as const,
        id: company.id,
        name: company.name,
        archived: false as const,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to restore company",
      };
    }
  },
});

export const listCrmFields = tool({
  description:
    "List workspace CRM custom field definitions (Notion-style properties on accounts): key, label, type, select options.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const client = getSupabaseServiceClient();
      const { listFieldDefs } = await import("@/lib/crm-fields");
      const fields = await listFieldDefs(client);
      return {
        success: true as const,
        fields: fields.map((f) => ({
          id: f.id,
          key: f.key,
          label: f.label,
          type: f.type,
          options: f.options,
          position: f.position,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to list fields",
      };
    }
  },
});

export const createCrmField = tool({
  description:
    "Create a CRM custom field definition for all accounts. Types: text, number, boolean, select. For select, pass options as label strings or {id,label}.",
  inputSchema: z.object({
    label: z.string().describe("Human label, e.g. Self-hosted"),
    type: z.enum(["text", "number", "boolean", "select"]),
    key: z
      .string()
      .optional()
      .describe("Stable key slug (optional; derived from label)"),
    options: z
      .array(
        z.union([
          z.string(),
          z.object({ id: z.string().optional(), label: z.string() }),
        ]),
      )
      .optional()
      .describe("Required for select — option labels or {id,label}"),
  }),
  execute: async ({ label, type, key, options }) => {
    try {
      const client = getSupabaseServiceClient();
      const { createFieldDef } = await import("@/lib/crm-fields");
      const normalized = (options ?? []).map((o) =>
        typeof o === "string" ? { id: "", label: o } : { id: o.id ?? "", label: o.label },
      );
      const field = await createFieldDef(client, {
        label,
        type,
        key,
        options: type === "select" ? normalized : undefined,
      });
      return { success: true as const, field };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to create field",
      };
    }
  },
});

export const updateCrmField = tool({
  description: "Update a CRM custom field definition (label, options, position). Key is immutable.",
  inputSchema: z.object({
    id: z.string().describe("Field def id"),
    label: z.string().optional(),
    options: z
      .array(
        z.union([
          z.string(),
          z.object({ id: z.string().optional(), label: z.string() }),
        ]),
      )
      .optional(),
    position: z.number().optional(),
  }),
  execute: async ({ id, label, options, position }) => {
    try {
      const client = getSupabaseServiceClient();
      const { updateFieldDef } = await import("@/lib/crm-fields");
      const normalized = options?.map((o) =>
        typeof o === "string" ? { id: "", label: o } : { id: o.id ?? "", label: o.label },
      );
      const field = await updateFieldDef(client, id, {
        label,
        options: normalized,
        position,
      });
      return { success: true as const, field };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to update field",
      };
    }
  },
});

export const deleteCrmField = tool({
  description:
    "Delete a CRM custom field definition. Account values for that key stop showing (orphans ignored).",
  inputSchema: z.object({
    id: z.string().describe("Field def id"),
  }),
  execute: async ({ id }) => {
    try {
      const client = getSupabaseServiceClient();
      const { deleteFieldDef } = await import("@/lib/crm-fields");
      const result = await deleteFieldDef(client, id);
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to delete field",
      };
    }
  },
});

export const addCrmComment = tool({
  description: "Add a markdown comment to a CRM company (logged in the activity timeline).",
  inputSchema: z.object({
    id: z.string().describe("Company id"),
    body_md: z.string().describe("Comment body in markdown"),
    user_email: z.string().optional().describe("Comment author email"),
  }),
  execute: async ({ id, body_md, user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const comment = await createComment(client, id, body_md, user_email);
      return { success: true as const, id: comment.id };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to add comment",
      };
    }
  },
});

function createLogCrmOutreachTool(userEmail?: string) {
  return tool({
    description:
      "Record an email, LinkedIn message, WhatsApp message, Slack message, phone call, or other outbound touch that was sent manually. Use this instead of addCrmComment when a message actually left Kodus: it updates last_outreach_at, the channel, the sent counter, and the activity timeline. This logs only; it does not send anything.",
    inputSchema: z.object({
      id: z.string().describe("CRM company id"),
      channel: z
        .enum(CRM_OUTREACH_CHANNELS as [
          CrmOutreachChannel,
          ...CrmOutreachChannel[],
        ])
        .describe("Channel used for the manual touch"),
      contact_id: z.string().optional().describe("Existing CRM contact id"),
      contact_name: z
        .string()
        .optional()
        .describe("Contact name when there is no CRM contact id"),
      note: z.string().optional().describe("Optional short context about the touch"),
      sent_at: z
        .string()
        .optional()
        .describe("ISO timestamp. Defaults to now; may be historical, never future"),
    }),
    execute: async ({
      id,
      channel,
      contact_id,
      contact_name,
      note,
      sent_at,
    }) => {
      try {
        if (!userEmail) {
          throw new Error("Unauthorized: authenticated user context is required");
        }
        const client = getSupabaseServiceClient();
        const company = await recordManualOutreach(
          client,
          id,
          {
            channel,
            contactId: contact_id,
            contactName: contact_name,
            note,
            sentAt: sent_at,
          },
          userEmail,
        );
        return {
          success: true as const,
          company_id: company.id,
          last_outreach_at: company.lastOutreachAt,
          last_outreach_channel: company.lastOutreachChannel ?? null,
          outreach_sent_count: company.outreachSentCount,
        };
      } catch (error) {
        return {
          success: false as const,
          message:
            error instanceof Error ? error.message : "Failed to record outreach",
        };
      }
    },
  });
}

export const createCrmContact = tool({
  description:
    "Add one known person to a CRM account by hand. This is the deliberate counterpart to enrichCrmCompanyContacts, which pays a data provider to guess who works there — use this one when you already know the person (they replied, they commented on a post, someone named them on a call). Two fields decide whether the contact is usable downstream: without an email sequenceEnrollCrm skips them, and without a linkedin URL LinkedIn steps have no profile to open. Does not deduplicate: check getCrmCompany's contacts first, and update the existing row instead of adding a second one for the same person.",
  inputSchema: z.object({
    company_id: z.string().describe("CRM company id"),
    name: z.string().describe("Full name (required)"),
    email: z.string().optional().describe("Work email — required for email sequence steps"),
    role: z.string().optional().describe("Job title, e.g. 'VP of Engineering'"),
    phone: z.string().optional(),
    linkedin: z
      .string()
      .optional()
      .describe("LinkedIn profile URL — required for LinkedIn sequence steps"),
    is_primary: z
      .boolean()
      .optional()
      .describe(
        "Make this the account's lead contact. Enrollment sorts contacts primary-first and by default takes only the first with an email, so this picks who gets written to. Defaults to false. Note it does not demote the current primary — clear that one with updateCrmContact if you are replacing it.",
      ),
  }),
  execute: async ({ company_id, name, email, role, phone, linkedin, is_primary }) => {
    try {
      const client = getSupabaseServiceClient();
      const contact = await createContact(client, company_id, {
        name,
        email,
        role,
        phone,
        linkedin,
        isPrimary: is_primary,
      });
      return {
        success: true as const,
        id: contact.id,
        contact: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          role: contact.role,
          linkedin: contact.linkedin,
          is_primary: contact.isPrimary,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to create contact",
      };
    }
  },
});

/**
 * Treat an all-whitespace string as "field not supplied".
 *
 * `updateContact` runs every text field through `trimOrNull`, which turns ""
 * into null — so passing an empty string through would clear the column, and
 * a model that fills an unknown field with "" instead of omitting it would
 * wipe a contact's email or LinkedIn with no error and no way back. Clearing
 * a field stays possible, but only by saying so with an explicit null.
 */
function blankToUndefined<T extends string | null | undefined>(
  v: T,
): T | undefined {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

export const updateCrmContact = tool({
  description:
    "Fix or fill in one existing contact — add the email you just learned, correct a job title, attach a LinkedIn URL, hand the lead-contact flag to someone else. Get the id from getCrmCompany's contacts. A field you omit is left alone, and so is one you send blank, so a field you have nothing for is never destructive; clearing a field takes an explicit null. 'name' is the exception that cannot be cleared at all — it takes no null, and a blank one is ignored like any other.",
  inputSchema: z.object({
    id: z.string().describe("Contact id (from getCrmCompany's contacts)"),
    name: z.string().optional().describe("New full name; cannot be blank"),
    email: z.string().nullable().optional(),
    role: z.string().nullable().optional().describe("Job title"),
    phone: z.string().nullable().optional(),
    linkedin: z.string().nullable().optional().describe("LinkedIn profile URL"),
    is_primary: z
      .boolean()
      .optional()
      .describe(
        "Lead contact flag — who enrollment writes to first. Setting it here does not demote the current primary; clear that one in a second call.",
      ),
  }),
  execute: async ({ id, name, email, role, phone, linkedin, is_primary }) => {
    try {
      const client = getSupabaseServiceClient();
      // updateContact skips any key that is undefined, so passing the args
      // straight through already means "omitted → leave the column alone".
      // blankToUndefined extends that to "" so a blank cannot clear a column.
      //
      // `name` gets the same treatment for a different reason: it cannot be
      // cleared at all (the schema has no null for it), so a blank name is
      // never a request, only noise — and letting it through meant
      // updateContact threw before the UPDATE ran, throwing away the fields
      // the caller did set alongside it.
      const contact = await updateContact(client, id, {
        name: blankToUndefined(name),
        email: blankToUndefined(email),
        role: blankToUndefined(role),
        phone: blankToUndefined(phone),
        linkedin: blankToUndefined(linkedin),
        isPrimary: is_primary,
      });
      return {
        success: true as const,
        contact: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          role: contact.role,
          linkedin: contact.linkedin,
          is_primary: contact.isPrimary,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to update contact",
      };
    }
  },
});

export const archiveCrmContact = tool({
  description:
    "Remove a person from an account — they left the company, they are the wrong buyer, they asked not to be contacted. Archives rather than deletes, on purpose: enrichCrmCompanyContacts matches discovered people against the contacts it can see, so a hard-deleted person came back on the next lookup while an archived one is matched and skipped. The contact disappears from the account, from getCrmCompany and from enrollment, and loses the lead-contact flag if it had it. There is no un-archive tool — undo it in the CRM UI.",
  inputSchema: z.object({
    id: z.string().describe("Contact id (from getCrmCompany's contacts)"),
  }),
  execute: async ({ id }) => {
    try {
      const client = getSupabaseServiceClient();
      await archiveContact(client, id);
      return { success: true as const, id, archived: true as const };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to archive contact",
      };
    }
  },
});

export const researchListTables = tool({
  description:
    "List Clay-style research lists/tables. Returns id, slug, name, row_count, and column keys — use slug or id in later tools (table_ref).",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const client = getSupabaseServiceClient();
      const tables = await listTables(client);
      return {
        success: true as const,
        tables: tables.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          row_count: t.rowCount ?? 0,
          columns: (t.columns ?? []).map((c) => ({
            key: c.key,
            label: c.label,
            type: c.type,
            enrich: c.enrich.kind,
          })),
          description: t.description,
        })),
        rubrics: listRubrics(),
        note: "Pass table_ref as slug, id, or exact name to other research* tools.",
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to list tables",
      };
    }
  },
});

export const researchCreateTable = tool({
  description:
    "Create a research list/table with a rubric (default qe-kodus-v1). Returns id + slug for deep links (/research?table=slug).",
  inputSchema: z.object({
    name: z.string(),
    rubric_id: z.string().optional().describe("qe-kodus-v1 | generic-b2b-v1"),
    user_email: z.string().optional(),
  }),
  execute: async ({ name, rubric_id, user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const table = await createTable(client, {
        name,
        rubricId: rubric_id ?? getDefaultRubricId(),
        createdByEmail: user_email,
      });
      return {
        success: true as const,
        table: {
          id: table.id,
          slug: table.slug,
          name: table.name,
          columns: table.columns,
        },
        open_url: table.slug
          ? `/research?table=${encodeURIComponent(table.slug)}`
          : `/research?table=${table.id}`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to create table",
      };
    }
  },
});

export const researchAddDomains = tool({
  description:
    "Add company domains to a research table (import candidates before research).",
  inputSchema: z.object({
    table_ref: z
      .string()
      .describe("Table id, slug, or unique name (preferred over raw UUID alone)"),
    table_id: z
      .string()
      .optional()
      .describe("Deprecated alias for table_ref"),
    domains: z
      .array(
        z.object({
          company_name: z.string().optional(),
          domain: z.string(),
        }),
      )
      .describe("List of domains / companies to add"),
    source: z.string().optional(),
  }),
  execute: async ({ table_ref, table_id, domains, source }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const table = await resolveTable(client, table_ref || table_id || "");
      const result = await addRows(
        client,
        table.id,
        domains.map((d) => ({
          companyName: d.company_name || d.domain,
          domain: d.domain,
          source: source ?? "agent",
        })),
        // Named companies, not a discovery sweep: a deliberate re-add clears
        // any earlier exclusion for them.
        { respectExclusions: false },
      );
      return {
        success: true as const,
        table_id: table.id,
        table_slug: table.slug,
        added: result.added,
        skipped: result.skipped,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to add domains",
      };
    }
  },
});

export const researchCompany = tool({
  description:
    "Run multi-source ICP research on one research row (careers, product, ship, news, pain packs + rubric score). Use after adding domains. Long-running.",
  inputSchema: z.object({
    row_id: z.string().describe("research_rows id"),
    force: z.boolean().optional().describe("Bypass cache"),
  }),
  execute: async ({ row_id, force }) => {
    try {
      const client = getSupabaseServiceClient();
      const result = await researchRow(client, row_id, { force });
      return {
        success: true as const,
        company: result.companyName,
        domain: result.domain,
        icp_score: result.score.icpScore,
        pass: result.score.pass,
        anti_flags: result.score.antiFlags,
        why_now: result.score.whyNow,
        criteria: result.score.criteria.map((c) => ({
          id: c.criterionId,
          kind: c.kind,
          status: c.status,
          evidence: c.evidence,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Research failed",
      };
    }
  },
});

export const researchListRows = tool({
  description:
    "List rows in a research table with ICP scores and dynamic cells. Filter to pass-only for outreach-ready companies.",
  inputSchema: z.object({
    table_ref: z.string().optional().describe("Table id, slug, or name"),
    table_id: z.string().optional().describe("Deprecated alias for table_ref"),
    pass_only: z.boolean().optional(),
    min_score: z.number().optional(),
    include_cells: z.boolean().optional().describe("Include dynamic column cells (default true)"),
  }),
  execute: async ({ table_ref, table_id, pass_only, min_score, include_cells }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const table = await resolveTable(client, table_ref || table_id || "");
      const rows = await listRows(client, table.id, {
        passOnly: pass_only,
        minScore: min_score,
      });
      const withCells = include_cells !== false;
      return {
        success: true as const,
        table: {
          id: table.id,
          slug: table.slug,
          name: table.name,
          columns: table.columns,
        },
        count: rows.length,
        rows: rows.map((r) => ({
          id: r.id,
          company: r.companyName,
          domain: r.domain,
          status: r.status,
          icp_score: r.icpScore,
          pass: r.pass,
          anti_flags: r.antiFlags,
          why_now: r.whyNow,
          ...(withCells ? { cells: r.cells ?? {} } : {}),
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed to list rows",
      };
    }
  },
});

const rowConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("domain_suffix"), value: z.string() }),
  z.object({ kind: z.literal("domain_includes"), value: z.string() }),
  z.object({ kind: z.literal("company_includes"), value: z.string() }),
  z.object({ kind: z.literal("company_regex"), value: z.string() }),
  z.object({ kind: z.literal("source"), value: z.string() }),
  z.object({ kind: z.literal("pass"), value: z.boolean() }),
  z.object({ kind: z.literal("min_score"), value: z.number() }),
  z.object({ kind: z.literal("max_score"), value: z.number() }),
  z.object({ kind: z.literal("status"), value: z.string() }),
  z.object({
    kind: z.literal("cell_eq"),
    key: z.string(),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("cell_includes"),
    key: z.string(),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("pack_path_eq"),
    path: z.string(),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("pack_path_includes"),
    path: z.string(),
    value: z.string(),
  }),
  z.object({ kind: z.literal("pack_text_includes"), value: z.string() }),
  z.object({
    kind: z.literal("row_ids"),
    value: z.array(z.string()),
  }),
]);

export const researchMoveRows = tool({
  description:
    "MOVE companies from one research list to another (or into a newly created list). People stay on the same rows. This is the only list-reorg primitive — do not invent split engines. Flow: researchListRows → pick row_ids (any criteria you or the user decide) → researchMoveRows. Prefer confirming the destination name with the user before bulk moves.",
  inputSchema: z.object({
    row_ids: z.array(z.string()).min(1),
    source_table_ref: z
      .string()
      .optional()
      .describe("Required when creating a new list (shell/columns/rubric)"),
    target_table_ref: z
      .string()
      .optional()
      .describe("Existing destination list id/slug/name"),
    new_table_name: z
      .string()
      .optional()
      .describe("Create a new list with this name and move rows into it"),
    user_email: z.string().optional(),
  }),
  execute: async ({
    row_ids,
    source_table_ref,
    target_table_ref,
    new_table_name,
    user_email,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const { moveRowsToTable } = await import("@/lib/research/split");
      let targetTableId: string | undefined;
      let sourceTableId: string | undefined;
      if (target_table_ref) {
        targetTableId = (await resolveTable(client, target_table_ref)).id;
      }
      if (source_table_ref || new_table_name) {
        const src = await resolveTable(
          client,
          source_table_ref || target_table_ref || "",
        );
        sourceTableId = src.id;
      }
      const result = await moveRowsToTable(client, {
        rowIds: row_ids,
        targetTableId,
        newTableName: new_table_name,
        sourceTableId,
        createdByEmail: user_email,
      });
      return {
        success: true as const,
        ...result,
        open_url: result.target.slug
          ? `/research?table=${encodeURIComponent(result.target.slug)}`
          : `/research?table=${result.target.id}`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Move failed",
      };
    }
  },
});

export const researchDeleteRows = tool({
  description:
    "Permanently remove selected companies from their research lists. A full list snapshot is saved first. Any active/paused enrollments for those companies are cancelled, while sent history stays intact. Removed companies are added to the list's exclusion list, so researchFindIcp will not re-import them; use researchExclusions to review or undo that. Confirm before calling.",
  inputSchema: z.object({
    row_ids: z.array(z.string()).min(1),
    confirm: z.boolean().describe("Must be true to delete the selected companies"),
    reason: z
      .string()
      .optional()
      .describe("Why they were removed — stored on the exclusion entry"),
    exclude: z
      .boolean()
      .optional()
      .describe(
        "Remember them so future imports skip them (default true). Set false for a one-off cleanup you want re-sourced later.",
      ),
    user_email: z.string().optional(),
  }),
  execute: async ({ row_ids, confirm, reason, exclude, user_email }) => {
    if (!confirm) {
      return {
        success: false as const,
        message: "Pass confirm=true to remove these companies from the list.",
      };
    }
    try {
      const client = getSupabaseServiceClient();
      const { deleteResearchRows } = await import("@/lib/research/tables");
      const result = await deleteResearchRows(client, row_ids, {
        exclude,
        reason,
        createdBy: user_email,
      });
      return {
        success: true as const,
        ...result,
        message: `Removed ${result.deleted} compan${result.deleted === 1 ? "y" : "ies"} and cancelled ${result.cancelledEnrollments} active enrollment(s).${
          result.excluded > 0
            ? ` ${result.excluded} added to the list's exclusion list — future finds will skip them.`
            : ""
        }`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Delete failed",
      };
    }
  },
});

export const researchExclusions = tool({
  description:
    "Review or undo a research list's exclusion list — the companies removed from it that future researchFindIcp / import runs skip. action=list shows them with the reason they were excluded; action=remove un-excludes named companies so they can be sourced again (it does not re-add the rows — run researchFindIcp or researchAddDomains after).",
  inputSchema: z.object({
    table_ref: z.string().describe("Table id, slug, or unique name"),
    action: z.enum(["list", "remove"]).optional(),
    companies: z
      .array(
        z.object({
          company_name: z.string().optional(),
          domain: z.string().optional(),
        }),
      )
      .optional()
      .describe("Required for action=remove: which exclusions to lift"),
  }),
  execute: async ({ table_ref, action, companies }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const { listExclusions, removeExclusions } = await import(
        "@/lib/research/exclusions"
      );
      const table = await resolveTable(client, table_ref);

      if (action === "remove") {
        if (!companies?.length) {
          return {
            success: false as const,
            message: "Pass companies[] to un-exclude.",
          };
        }
        const removed = await removeExclusions(
          client,
          table.id,
          companies.map((c) => ({
            companyName: c.company_name ?? null,
            domain: c.domain ?? null,
          })),
        );
        return {
          success: true as const,
          table_id: table.id,
          removed,
          message: `Lifted ${removed} exclusion(s) on "${table.name}". They can be sourced into the list again.`,
        };
      }

      const exclusions = await listExclusions(client, table.id);
      return {
        success: true as const,
        table_id: table.id,
        table_slug: table.slug,
        count: exclusions.length,
        exclusions,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Exclusions failed",
      };
    }
  },
});

export const researchListHistory = tool({
  description:
    "List recovery snapshots for a research list. Every move and list deletion creates one automatically. Use researchRestoreListSnapshot to return a list to an exact earlier version.",
  inputSchema: z.object({
    table_ref: z.string(),
    limit: z.number().optional(),
  }),
  execute: async ({ table_ref, limit }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const { listResearchTableSnapshots } = await import(
        "@/lib/research/tables"
      );
      const table = await resolveTable(client, table_ref);
      const snapshots = await listResearchTableSnapshots(client, table.id, limit ?? 20);
      return { success: true as const, table, snapshots };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "History failed",
      };
    }
  },
});

export const researchRestoreListSnapshot = tool({
  description:
    "Restore a research list exactly from a recovery snapshot. This replaces the current list state, including its companies, people, and evidence; the current state is snapshotted first, so the restore can itself be undone. Confirm before calling.",
  inputSchema: z.object({
    snapshot_id: z.string(),
    confirm: z.boolean().describe("Must be true to perform the exact restore"),
    user_email: z.string().optional(),
  }),
  execute: async ({ snapshot_id, confirm, user_email }) => {
    if (!confirm) {
      return {
        success: false as const,
        message: "Pass confirm=true to replace the current list with this snapshot.",
      };
    }
    try {
      const client = getSupabaseServiceClient();
      const { restoreResearchTableSnapshot } = await import(
        "@/lib/research/tables"
      );
      const table = await restoreResearchTableSnapshot(client, snapshot_id, {
        createdBy: user_email,
      });
      return { success: true as const, table };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Restore failed",
      };
    }
  },
});

export const researchSplitByRules = tool({
  description:
    "Horizontal split: partition a research list into N named buckets by generic rules (first matching rule wins). Conditions: domain_suffix, domain_includes, company_includes, company_regex, source, pass, min_score, max_score, status, cell_eq, cell_includes, pack_path_eq, pack_path_includes, pack_text_includes, row_ids. dry_run defaults true. remainder=leave keeps unmatched in source; remainder=new_list creates another list. Example language split: rules=[{name:'Brasil', match:'any', conditions:[{kind:'domain_suffix',value:'.br'},{kind:'pack_path_eq',path:'firmo.meta.hqCountry',value:'BR'}]}], remainder='new_list', remainder_name:'Global'.",
  inputSchema: z.object({
    table_ref: z.string(),
    rules: z
      .array(
        z.object({
          name: z.string(),
          match: z.enum(["all", "any"]).optional(),
          conditions: z.array(rowConditionSchema).min(1),
        }),
      )
      .min(1),
    remainder: z.enum(["leave", "new_list"]).optional(),
    remainder_name: z.string().optional(),
    dry_run: z.boolean().optional(),
    user_email: z.string().optional(),
  }),
  execute: async ({
    table_ref,
    rules,
    remainder,
    remainder_name,
    dry_run,
    user_email,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const { splitTableByRules } = await import("@/lib/research/split");
      const table = await resolveTable(client, table_ref);
      const result = await splitTableByRules(client, table.id, {
        rules,
        remainder: remainder ?? "leave",
        remainderName: remainder_name,
        dryRun: dry_run !== false,
        createdByEmail: user_email,
      });
      return {
        success: true as const,
        ...result,
        next: result.dryRun
          ? "Looks good? Call again with dry_run=false to create lists and move rows."
          : "Open the new lists via slug/id. Source may still hold remainder rows if remainder=leave.",
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Split failed",
      };
    }
  },
});

export const researchCreateFromIcp = tool({
  description:
    "Create a research table from a FREE-TEXT ICP description (Clay-style). Compiles the ICP into a custom scoring rubric (triggers, fits, anti-criteria with veto) + signal-first discovery queries, creates the table, and optionally runs discovery right away. Use when the user describes who they want to find in natural language — including exclusions like 'não quero fábricas de software'.",
  inputSchema: z.object({
    icp_text: z
      .string()
      .describe("The ICP description verbatim (paste the user's full text)"),
    market: z.enum(["global", "brazil"]).optional(),
    find_now: z
      .boolean()
      .optional()
      .describe("Run discovery immediately after creating (default true)"),
    max_companies: z.number().optional().describe("Cap for immediate find (max 8 in chat)"),
    user_email: z.string().optional(),
  }),
  execute: async ({ icp_text, market, find_now, max_companies, user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const { buildIcpPlanFromPrompt } = await import("@/lib/research/icp-plan");
      const plan = await buildIcpPlanFromPrompt(icp_text, {
        marketHint: market ?? null,
      });

      const table = await createTable(client, {
        name: plan.tableName,
        rubricJson: plan.rubric,
        description: plan.interpretation || null,
        createdByEmail: user_email,
      });

      let find: {
        discovered: number;
        added: number;
        researched: number;
        passed: number;
      } | null = null;
      if (find_now !== false) {
        const { findIcpCompanies } = await import("@/lib/research/find");
        const found = await findIcpCompanies(client, {
          tableId: table.id,
          market: plan.market,
          size: plan.size,
          maxCompanies: Math.min(max_companies ?? 6, 8),
          queries: plan.queries,
          keywords: plan.keywords,
          hunts: plan.hunts,
          excludeNamePatterns: plan.excludeNamePatterns,
        });
        let researched = 0;
        let passed = 0;
        if (found.rowIds.length > 0) {
          const { researchRows } = await import("@/lib/research/research-company");
          const result = await researchRows(client, found.rowIds, {
            concurrency: 1,
          });
          researched = result.ok;
          passed = result.results.filter((r) => r.score.pass).length;
        }
        find = {
          discovered: found.discovered,
          added: found.added,
          researched,
          passed,
        };
      }

      return {
        success: true as const,
        table_id: table.id,
        table_name: table.name,
        interpretation: plan.interpretation,
        rubric_summary: plan.rubric.criteria.map((c) => ({
          id: c.id,
          kind: c.kind,
          weight: c.weight,
          veto: c.veto ?? false,
        })),
        discovery_queries: plan.queries,
        excluded_name_patterns: plan.excludeNamePatterns,
        call_checklist: plan.callChecklist,
        find,
        note: "Review 'interpretation' with the user; rubric is stored on the table and used for all research in it. For large runs use the Research UI.",
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Failed to compile ICP",
      };
    }
  },
});

export const researchFindIcp = tool({
  description:
    "Find companies matching the QE ICP, then score each with the research rubric. market=brazil sources from Gupy, Programathor, and Workable/LinkedIn filtered to Brazil, then tops up the remaining slots from the global ATS harvest (Greenhouse/Lever/Ashby) using Brazilian signal phrases — so a brazil run can still return non-Brazilian companies from that top-up; market=global adds Remotive and drops the Brazil location filters. Each row records its source board at pack_raw.discovery.ats, so results can be filtered by it. Companies previously deleted from the list are skipped (see researchExclusions). Long-running — prefer UI for large runs; agent use max 6.",
  inputSchema: z.object({
    table_id: z.string().describe("Research table id"),
    market: z.enum(["global", "brazil"]).optional(),
    size: z.enum(["any", "small", "mid", "large"]).optional(),
    max_companies: z.number().optional(),
    focus: z.string().optional(),
    research_after: z.boolean().optional().describe("Score after find (default true)"),
  }),
  execute: async ({
    table_id,
    market,
    size,
    max_companies,
    focus,
    research_after,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const { findIcpCompanies } = await import("@/lib/research/find");
      const found = await findIcpCompanies(client, {
        tableId: table_id,
        market: market ?? "brazil",
        size: size ?? "mid",
        maxCompanies: Math.min(max_companies ?? 6, 12),
        focus: focus ?? null,
      });
      let research: { ok: number; failed: number; passed: number } | null = null;
      if (research_after !== false && found.rowIds.length > 0) {
        const { researchRows } = await import("@/lib/research/research-company");
        const result = await researchRows(client, found.rowIds, {
          concurrency: 1,
        });
        research = {
          ok: result.ok,
          failed: result.failed,
          passed: result.results.filter((r) => r.score.pass).length,
        };
      }
      return {
        success: true as const,
        discovered: found.discovered,
        added: found.added,
        skipped: found.skipped,
        excluded: found.excluded,
        market: found.market,
        size: found.size,
        research,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Find ICP failed",
      };
    }
  },
});

export const researchEnrichPeople = tool({
  description:
    "Find buyer personas (people/leads) for companies in a research table: team-page scrape + email guess, then NinjaPear/Hunter if needed. Targets the table's personas (rubric default_personas, editable with researchSetPersonas) or the `personas` passed here; titles match PT/EN synonyms (Founder also hits Fundador/Sócio). People whose title matches no persona, or whose profile says they do not work at the company, are dropped rather than kept as low-confidence. Use onlyIfPass=false for pre-qualified CSV lists that were not ICP-scored yet. Long-running — prefer small batches (max 15 in agent).",
  inputSchema: z.object({
    table_ref: z.string().optional().describe("Table id, slug, or name"),
    table_id: z.string().optional().describe("Deprecated alias for table_ref"),
    only_if_pass: z
      .boolean()
      .optional()
      .describe("Only enrich rows that passed ICP (default true). Set false for CSV imports."),
    max_rows: z
      .number()
      .optional()
      .describe("Cap how many rows to enrich this call (default 8, max 15)"),
    max_people: z
      .number()
      .optional()
      .describe("Max people per company (default 3)"),
    row_ids: z
      .array(z.string())
      .optional()
      .describe("Optional explicit row ids; if omitted, takes from table"),
    personas: z
      .array(z.string())
      .optional()
      .describe(
        "Override the table's personas for this call only, e.g. ['Founder', 'CEO', 'Sócio comercial', 'Head of Delivery']. To change them permanently use researchSetPersonas.",
      ),
  }),
  execute: async ({ table_ref, table_id, only_if_pass, max_rows, max_people, row_ids, personas }) => {
    try {
      const client = getSupabaseServiceClient();
      const { enrichPeopleForRows } = await import("@/lib/research/waterfall");
      const { listPeople } = await import("@/lib/research/tables");
      const { resolveTable } = await import("@/lib/research/columns");
      const table = await resolveTable(client, table_ref || table_id || "");

      let ids = row_ids ?? [];
      if (ids.length === 0) {
        const rows = await listRows(client, table.id);
        const filtered =
          only_if_pass === false
            ? rows
            : rows.filter((r) => r.pass === true);
        const cap = Math.min(max_rows ?? 8, 15);
        ids = filtered.slice(0, cap).map((r) => r.id);
      } else {
        ids = ids.slice(0, Math.min(max_rows ?? 15, 15));
      }

      if (ids.length === 0) {
        return {
          success: true as const,
          message: "No rows to enrich (check only_if_pass / table contents)",
          ok: 0,
          failed: 0,
          total_people: 0,
          sample: [],
        };
      }

      const result = await enrichPeopleForRows(client, ids, {
        onlyIfPass: only_if_pass !== false,
        maxPeople: max_people ?? 3,
        personas: personas && personas.length > 0 ? personas : undefined,
      });

      // Return a small sample of people found for agent visibility
      const sample: Array<{
        row_id: string;
        people: Array<{ name: string; role: string | null; email: string | null; linkedin: string | null }>;
      }> = [];
      for (const id of ids.slice(0, 5)) {
        const people = await listPeople(client, id);
        if (people.length === 0) continue;
        sample.push({
          row_id: id,
          people: people.map((p) => ({
            name: p.name,
            role: p.role,
            email: p.email,
            linkedin: p.linkedin,
          })),
        });
      }

      return {
        success: true as const,
        rows_processed: ids.length,
        ok: result.ok,
        failed: result.failed,
        total_people: result.totalPeople,
        sample,
        note: "People saved on research_people. Open the Research UI or export CSV for full list. Re-call with next batch if more rows remain.",
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "People enrichment failed",
      };
    }
  },
});

export const researchGetTable = tool({
  description:
    "Get one research table by id, slug, or unique name — includes column schema. Use before create/run columns.",
  inputSchema: z.object({
    table_ref: z.string().describe("UUID, slug, or unique table name"),
  }),
  execute: async ({ table_ref }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const { resolveRubric } = await import("@/lib/research/rubrics");
      const table = await resolveTable(client, table_ref);
      let personas: string[] = [];
      try {
        personas = resolveRubric(table).default_personas;
      } catch {
        /* unreadable rubric — leave personas empty */
      }
      return {
        success: true as const,
        table: {
          id: table.id,
          slug: table.slug,
          name: table.name,
          description: table.description,
          row_count: table.rowCount,
          columns: table.columns,
          personas,
          open_url: table.slug
            ? `/research?table=${encodeURIComponent(table.slug)}`
            : `/research?table=${table.id}`,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Table not found",
      };
    }
  },
});

export const researchSetPersonas = tool({
  description:
    "Set the buyer personas that people enrichment targets for a research table (who to find at each company, e.g. ['Founder', 'CEO', 'Sócio comercial', 'Head of Delivery'] for a partner list, or ['CTO', 'VP Engineering', 'Head of Platform'] for a buyer list). Replaces the table's current personas; up to 10. Titles are matched with PT/EN synonyms. Run researchEnrichPeople afterwards — already-saved people are kept, new finds follow the new personas.",
  inputSchema: z.object({
    table_ref: z.string().describe("Table id, slug, or unique name"),
    personas: z
      .array(z.string())
      .min(1)
      .max(10)
      .describe("Roles to target, most important first"),
  }),
  execute: async ({ table_ref, personas }) => {
    try {
      const client = getSupabaseServiceClient();
      const { resolveTable } = await import("@/lib/research/columns");
      const { updateTablePersonas } = await import("@/lib/research/tables");
      const table = await resolveTable(client, table_ref);
      const saved = await updateTablePersonas(client, table.id, personas);
      return {
        success: true as const,
        table_id: table.id,
        table_slug: table.slug,
        personas: saved,
        note: "Saved on the table's rubric. Call researchEnrichPeople to find people with these personas.",
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Failed to set personas",
      };
    }
  },
});

export const researchCreateColumn = tool({
  description:
    "Create a dynamic column on a research table (Clay-style). enrich.kind: none | ai (needs prompt; sourceColumnKeys can restrict evidence to named cells) | people_field (field: linkedin|email|name|role). Example: contact_linkedin with people_field linkedin.",
  inputSchema: z.object({
    table_ref: z.string().describe("Table id, slug, or name"),
    label: z.string().describe("Human label, e.g. Contact LinkedIn"),
    key: z
      .string()
      .optional()
      .describe("snake_case key; default slugified from label"),
    type: z
      .enum(["text", "url", "email", "boolean", "number"])
      .optional()
      .describe("Default text; use url for LinkedIn"),
    enrich: z
      .object({
        kind: z.enum(["none", "ai", "people_field"]),
        prompt: z.string().optional(),
        sourceColumnKeys: z.array(z.string()).optional(),
        field: z.enum(["linkedin", "email", "name", "role"]).optional(),
        runPeopleIfMissing: z.boolean().optional(),
      })
      .optional(),
    run_now: z
      .boolean()
      .optional()
      .describe("If true, immediately run enrich on missing cells (max 30)"),
  }),
  execute: async ({ table_ref, label, key, type, enrich, run_now }) => {
    try {
      const client = getSupabaseServiceClient();
      const { createColumn, runColumn } = await import("@/lib/research/columns");
      const created = await createColumn(client, table_ref, {
        label,
        key,
        type,
        enrich: enrich ?? { kind: "none" },
      });
      let run: Awaited<ReturnType<typeof runColumn>> | null = null;
      if (run_now && created.column.enrich.kind !== "none") {
        run = await runColumn(client, created.table.id, created.column.key, {
          onlyMissing: true,
          maxRows: 30,
        });
      }
      return {
        success: true as const,
        table_id: created.table.id,
        table_slug: created.table.slug,
        column: created.column,
        columns: created.columns,
        run: run
          ? { ok: run.ok, failed: run.failed, skipped: run.skipped, sample: run.sample }
          : null,
        note: run_now
          ? "Column created and enrich started for up to 30 missing rows."
          : "Column created. Call researchRunColumn to fill values.",
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Create column failed",
      };
    }
  },
});

export const researchUpdateColumn = tool({
  description: "Update a dynamic column (label, type, enrich, order, or rename key).",
  inputSchema: z.object({
    table_ref: z.string(),
    key: z.string(),
    label: z.string().optional(),
    type: z.enum(["text", "url", "email", "boolean", "number"]).optional(),
    enrich: z
      .object({
        kind: z.enum(["none", "ai", "people_field"]),
        prompt: z.string().optional(),
        sourceColumnKeys: z.array(z.string()).optional(),
        field: z.enum(["linkedin", "email", "name", "role"]).optional(),
        runPeopleIfMissing: z.boolean().optional(),
      })
      .optional(),
    order: z.number().optional(),
    new_key: z.string().optional(),
  }),
  execute: async ({ table_ref, key, label, type, enrich, order, new_key }) => {
    try {
      const client = getSupabaseServiceClient();
      const { updateColumn } = await import("@/lib/research/columns");
      const result = await updateColumn(client, table_ref, key, {
        label,
        type,
        enrich,
        order,
        newKey: new_key,
      });
      return {
        success: true as const,
        column: result.column,
        columns: result.columns,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Update column failed",
      };
    }
  },
});

export const researchDeleteColumn = tool({
  description:
    "Delete a dynamic column from a research table. By default purges cell values too.",
  inputSchema: z.object({
    table_ref: z.string(),
    key: z.string(),
    purge_cells: z.boolean().optional(),
  }),
  execute: async ({ table_ref, key, purge_cells }) => {
    try {
      const client = getSupabaseServiceClient();
      const { deleteColumn } = await import("@/lib/research/columns");
      const result = await deleteColumn(client, table_ref, key, {
        purgeCells: purge_cells !== false,
      });
      return {
        success: true as const,
        columns: result.columns,
        table_slug: result.table.slug,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Delete column failed",
      };
    }
  },
});

export const researchRunColumn = tool({
  description:
    "Run enrich for one dynamic column across rows (AI prompt or people_field). Caps at max_rows (default 25, max 50). Prefer only_missing=true.",
  inputSchema: z.object({
    table_ref: z.string(),
    key: z.string().describe("Column key, e.g. contact_linkedin"),
    only_missing: z.boolean().optional(),
    max_rows: z.number().optional(),
    row_ids: z.array(z.string()).optional(),
  }),
  execute: async ({ table_ref, key, only_missing, max_rows, row_ids }) => {
    try {
      const client = getSupabaseServiceClient();
      const { runColumn } = await import("@/lib/research/columns");
      const result = await runColumn(client, table_ref, key, {
        onlyMissing: only_missing !== false,
        maxRows: Math.min(max_rows ?? 25, 50),
        rowIds: row_ids,
      });
      return {
        success: true as const,
        table_id: result.table.id,
        table_slug: result.table.slug,
        column: result.column,
        ok: result.ok,
        failed: result.failed,
        skipped: result.skipped,
        sample: result.sample,
        note: "Re-call with next batch if more rows remain. Open /research?table=<slug> to view.",
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Run column failed",
      };
    }
  },
});

export const researchSetCell = tool({
  description: "Manually set a cell value on a row for a dynamic column.",
  inputSchema: z.object({
    row_id: z.string(),
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    evidence: z.string().optional(),
  }),
  execute: async ({ row_id, key, value, evidence }) => {
    try {
      const client = getSupabaseServiceClient();
      const { setCell } = await import("@/lib/research/columns");
      const cell = await setCell(client, row_id, key, value, {
        status: "done",
        evidence: evidence ?? null,
      });
      return { success: true as const, cell };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Set cell failed",
      };
    }
  },
});

export const researchUpsertPeople = tool({
  description:
    "Add or update contacts on a research row (company). DEFAULT is merge: never deletes existing people — fills email/linkedin/role gaps and adds new names. Only pass replace_existing=true for a deliberate full wipe (a snapshot is still saved first). Prefer merge when finding emails. Optionally syncs contact_linkedin cell.",
  inputSchema: z.object({
    row_id: z.string().describe("research_rows id"),
    people: z
      .array(
        z.object({
          name: z.string(),
          role: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
          linkedin: z.string().nullable().optional(),
        }),
      )
      .optional()
      .describe("Contacts to merge in (default) or full list if replace_existing"),
    name: z.string().optional().describe("Shortcut: single primary contact name"),
    role: z.string().optional(),
    email: z.string().optional(),
    linkedin: z.string().optional(),
    replace_existing: z
      .boolean()
      .optional()
      .describe(
        "DANGEROUS: if true, replaces entire people list (snapshot kept). Default false = merge only.",
      ),
  }),
  execute: async ({
    row_id,
    people,
    name,
    role,
    email,
    linkedin,
    replace_existing,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const { savePeople, listPeople, getRow } = await import(
        "@/lib/research/tables"
      );
      const { setCell } = await import("@/lib/research/columns");
      const row = await getRow(client, row_id);
      if (!row) {
        return { success: false as const, message: "Row not found" };
      }

      let list = people;
      if ((!list || list.length === 0) && name?.trim()) {
        list = [
          {
            name: name.trim(),
            role: role ?? null,
            email: email ?? null,
            linkedin: linkedin ?? null,
          },
        ];
      }
      if (!list?.length) {
        return {
          success: false as const,
          message: "Provide people[] or name for primary contact",
        };
      }

      const cleaned = list
        .map((p) => ({
          name: p.name.trim(),
          role: p.role ?? null,
          email: p.email ?? null,
          linkedin: p.linkedin ?? null,
          emailSource: "manual" as const,
          providerUsed: "manual",
          confidence: 1,
        }))
        .filter((p) => p.name.length > 0);

      const before = await listPeople(client, row_id);
      const saved = await savePeople(client, row_id, cleaned, {
        mode: replace_existing === true ? "replace" : "merge",
        reason:
          replace_existing === true ? "agent_replace" : "agent_merge",
      });

      const top = saved.find((p) => p.linkedin) ?? saved[0];
      if (top?.linkedin) {
        try {
          await setCell(client, row_id, "contact_linkedin", top.linkedin, {
            status: "done",
            evidence: `Manual: ${top.name}`,
          });
        } catch {
          /* column optional */
        }
      }

      return {
        success: true as const,
        mode: replace_existing === true ? "replace" : "merge",
        company: row.companyName,
        domain: row.domain,
        before_count: before.length,
        after_count: saved.length,
        people: saved.map((p) => ({
          name: p.name,
          role: p.role,
          email: p.email,
          linkedin: p.linkedin,
        })),
        note:
          replace_existing === true
            ? "Full replace done (prior list snapshotted). Prefer merge next time."
            : `Merged ${cleaned.length} contact(s) into ${before.length} existing → ${saved.length} total. Nobody was deleted.`,
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Upsert people failed",
      };
    }
  },
});

export const researchPeopleHistory = tool({
  description:
    "List people snapshots for a research company row (history before enrich/upsert). Use before restore if contacts were lost.",
  inputSchema: z.object({
    row_id: z.string(),
    limit: z.number().optional(),
  }),
  execute: async ({ row_id, limit }) => {
    try {
      const client = getSupabaseServiceClient();
      const { listPeopleSnapshots, listPeople } = await import(
        "@/lib/research/tables"
      );
      const [current, snapshots] = await Promise.all([
        listPeople(client, row_id),
        listPeopleSnapshots(client, row_id, limit ?? 20),
      ]);
      return {
        success: true as const,
        current_count: current.length,
        current: current.map((p) => ({
          name: p.name,
          email: p.email,
          linkedin: p.linkedin,
        })),
        snapshots: snapshots.map((s) => ({
          id: s.id,
          reason: s.reason,
          person_count: s.personCount,
          created_at: s.createdAt,
          people_preview: s.people.slice(0, 8).map((p) => p.name),
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "History failed",
      };
    }
  },
});

export const researchRestorePeople = tool({
  description:
    "Restore a research row's people list from a snapshot id (from researchPeopleHistory). Default mode=replace restores exactly that snapshot (prior list is snapshotted first).",
  inputSchema: z.object({
    row_id: z.string(),
    snapshot_id: z.string(),
    mode: z.enum(["merge", "replace"]).optional(),
  }),
  execute: async ({ row_id, snapshot_id, mode }) => {
    try {
      const client = getSupabaseServiceClient();
      const { restorePeopleSnapshot } = await import("@/lib/research/tables");
      const saved = await restorePeopleSnapshot(client, row_id, snapshot_id, {
        mode: mode ?? "replace",
      });
      return {
        success: true as const,
        count: saved.length,
        people: saved.map((p) => ({
          name: p.name,
          email: p.email,
          linkedin: p.linkedin,
          role: p.role,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Restore failed",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Outreach sequences — full campaign lifecycle for CLI / MCP agents
// ---------------------------------------------------------------------------

export const outreachListMailboxes = tool({
  description:
    "List connected outreach sender mailboxes. Use the returned id as mailbox_id on sequenceCreate or sequenceUpdate to choose one sender per campaign.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const client = getSupabaseServiceClient();
      const { listMailboxes } = await import("@/lib/outreach/mailbox");
      const mailboxes = await listMailboxes(client);
      return {
        success: true as const,
        mailboxes: mailboxes.map((mailbox) => ({
          id: mailbox.id,
          label: mailbox.label,
          from_email: mailbox.fromEmail,
          connected: mailbox.connected,
          enabled: mailbox.enabled,
          is_default: mailbox.isDefault,
        })),
      };
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : "Failed" };
    }
  },
});

/**
 * Both inbox tools take either a company id or a name/domain. Resolving here
 * keeps the caller from having to run listCrmCompanies first, but an ambiguous
 * name must NOT silently pick the first hit — the wrong account would return a
 * plausible, complete-looking correspondence history for someone else.
 */
async function resolveCompanyRef(
  client: ReturnType<typeof getSupabaseServiceClient>,
  ref: { company_id?: string; company?: string },
): Promise<
  | { ok: true; id: string; name: string }
  | { ok: false; message: string; candidates?: { id: string; name: string; domain: string | null }[] }
> {
  if (ref.company_id?.trim()) {
    const company = await getCompany(client, ref.company_id.trim());
    if (!company) return { ok: false, message: "Company not found" };
    return { ok: true, id: company.id, name: company.name };
  }

  const term = ref.company?.trim();
  if (!term) {
    return { ok: false, message: "Pass company_id or company (name or domain)" };
  }

  const matches = await listCompanies(client, { search: term, limit: 10 });
  if (matches.length === 0) {
    return { ok: false, message: `No CRM company matches "${term}"` };
  }
  // An exact name/domain hit beats the substring noise around it.
  const exact = matches.filter(
    (c) =>
      c.name.toLowerCase() === term.toLowerCase() ||
      (c.domain ?? "").toLowerCase() === term.toLowerCase(),
  );
  const pool = exact.length === 1 ? exact : matches;
  if (pool.length > 1) {
    return {
      ok: false,
      message: `"${term}" matches ${pool.length} companies — call again with company_id`,
      candidates: pool.map((c) => ({ id: c.id, name: c.name, domain: c.domain })),
    };
  }
  return { ok: true, id: pool[0].id, name: pool[0].name };
}

export const crmGetCompanyEmails = tool({
  description:
    "Full email correspondence with a CRM account, in both directions, searched live in Gmail across every connected mailbox (not just sequence replies). Matches on the company domain and on its contacts' emails. Use this to answer 'what have we exchanged with <company>' or to read the history before writing a follow-up. Mailboxes connected without gmail.readonly are reported as skipped instead of silently returning nothing.",
  inputSchema: z.object({
    company_id: z.string().optional().describe("CRM company id (preferred)"),
    company: z
      .string()
      .optional()
      .describe("Company name or domain, when the id is unknown"),
    limit: z
      .number()
      .optional()
      .describe("Max messages to return, newest first (default 40)"),
    include_body: z
      .boolean()
      .optional()
      .describe("Include full message bodies instead of snippets (default false)"),
  }),
  execute: async ({ company_id, company, limit, include_body }) => {
    try {
      const client = getSupabaseServiceClient();
      const resolved = await resolveCompanyRef(client, { company_id, company });
      if (!resolved.ok) {
        return {
          success: false as const,
          message: resolved.message,
          candidates: resolved.candidates,
        };
      }

      const { getCompanyEmailTimeline } = await import("@/lib/crm-emails");
      const timeline = await getCompanyEmailTimeline(client, resolved.id);
      if (!timeline) {
        return { success: false as const, message: "Company not found" };
      }

      const max = Math.min(200, Math.max(1, limit ?? 40));
      const skipped = timeline.mailboxes.filter((m) => !m.ok);

      return {
        success: true as const,
        company: { id: resolved.id, name: resolved.name },
        // What the search actually keyed on — a thin match here is the usual
        // reason the history looks emptier than the user expects.
        matched_on: {
          domain: timeline.match.domain,
          contact_emails: timeline.match.contactEmails,
        },
        counts: timeline.counts,
        // Non-fatal: some mailboxes answer while others lack read scope.
        mailboxes_skipped: skipped.map((m) => ({
          from_email: m.fromEmail,
          reason: m.skipReason ?? m.error ?? "unknown",
        })),
        messages: timeline.items.slice(0, max).map((m) => ({
          at: m.at,
          direction: m.direction,
          from: m.fromEmail,
          to: m.toEmail,
          subject: m.subject,
          body: include_body ? m.bodyText : null,
          snippet: m.snippet,
          mailbox: m.mailboxEmail,
          sequence: m.sequenceName,
          gmail_thread_id: m.gmailThreadId,
        })),
        truncated: timeline.items.length > max,
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Failed to load company emails",
      };
    }
  },
});

export const outreachListReplyThreads = tool({
  description:
    "Reply inbox threads — inbound answers to outbound sequences, on both email (Gmail) and LinkedIn (Unipile). Filter by company to see everything a given account replied. Note the scope difference vs crmGetCompanyEmails: this reads the synced reply inbox, so it covers LinkedIn but only holds conversations tied to a sequence; crmGetCompanyEmails searches Gmail live and covers all email, including threads that never came from a cadence.",
  inputSchema: z.object({
    company_id: z.string().optional().describe("CRM company id"),
    company: z
      .string()
      .optional()
      .describe("Company name or domain, when the id is unknown"),
    channel: z
      .enum(["email", "linkedin", "all"])
      .optional()
      .describe("Default all"),
    status: z
      .enum(["new", "open", "done", "snoozed", "active", "all"])
      .optional()
      .describe("active = new+open+snoozed (default); all = includes done"),
    limit: z.number().optional().describe("Max threads (default 50, cap 200)"),
    include_messages: z
      .boolean()
      .optional()
      .describe(
        "Expand each thread with its messages, both directions (default false; capped at 10 threads)",
      ),
  }),
  execute: async ({ company_id, company, channel, status, limit, include_messages }) => {
    try {
      const client = getSupabaseServiceClient();

      let resolvedCompany: { id: string; name: string } | null = null;
      if (company_id?.trim() || company?.trim()) {
        const resolved = await resolveCompanyRef(client, { company_id, company });
        if (!resolved.ok) {
          return {
            success: false as const,
            message: resolved.message,
            candidates: resolved.candidates,
          };
        }
        resolvedCompany = { id: resolved.id, name: resolved.name };
      }

      const { listReplyThreads, getReplyThread } = await import(
        "@/lib/outreach/inbox"
      );
      const { threads, newCount } = await listReplyThreads(client, {
        companyId: resolvedCompany?.id,
        channel: channel ?? "all",
        status: status ?? "active",
        limit,
      });

      // Expanding every thread would be one query each; cap it and say so
      // rather than quietly returning bodies for only part of the list.
      const EXPAND_CAP = 10;
      const expandIds = include_messages
        ? threads.slice(0, EXPAND_CAP).map((t) => t.id)
        : [];
      const messagesByThread = new Map<
        string,
        { at: string | null; direction: string; from: string | null; subject: string | null; body: string | null }[]
      >();
      for (const id of expandIds) {
        const detail = await getReplyThread(client, id);
        if (!detail) continue;
        messagesByThread.set(
          id,
          detail.messages.map((m) => ({
            at: m.internalDate,
            direction: m.direction,
            from: m.fromEmail,
            subject: m.subject,
            body: m.bodyText ?? m.snippet,
          })),
        );
      }

      return {
        success: true as const,
        company: resolvedCompany,
        new_count: newCount,
        threads: threads.map((t) => ({
          id: t.id,
          channel: t.channel,
          contact_name: t.contactName,
          contact_email: t.contactEmail,
          contact_linkedin: t.contactLinkedin,
          company_name: t.companyName,
          subject: t.subject,
          snippet: t.snippet,
          status: t.status,
          // How the thread was tied to an enrollment — 'unmatched' means it
          // landed in the inbox without a cadence behind it.
          matched_how: t.matchedHow,
          sequence: t.sequenceName ?? null,
          message_count: t.messageCount,
          first_inbound_at: t.firstInboundAt,
          last_inbound_at: t.lastInboundAt,
          messages: messagesByThread.get(t.id) ?? null,
        })),
        messages_truncated:
          Boolean(include_messages) && threads.length > EXPAND_CAP,
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Failed to list reply threads",
      };
    }
  },
});

const sequenceStepSchema = z.object({
  channel: z
    .enum(["linkedin", "email"])
    .describe("linkedin = human queue semi; email = auto or semi"),
  mode: z
    .enum(["auto", "semi"])
    .optional()
    .describe("linkedin always semi; email default auto"),
  delay_hours: z
    .number()
    .optional()
    .describe("Hours after previous step (0 = immediately / on enroll)"),
  linkedin_action: z
    .enum(["connect_note", "message"])
    .optional()
    .describe("Required for linkedin steps"),
  email_thread_mode: z
    .enum(["new", "reply"])
    .optional()
    .describe(
      "Email only: new = start a new conversation; reply = In-Reply-To previous email for this lead (default reply if omitted)",
    ),
  subject_template: z
    .string()
    .optional()
    .describe(`Email subject. ${TEMPLATE_TOKEN_HELP}`),
  body_template: z
    .string()
    .describe(
      `Message body. ${TEMPLATE_TOKEN_HELP} Write in the campaign language (e.g. pt-BR).`,
    ),
});

function mapStepInput(
  s: z.infer<typeof sequenceStepSchema>,
): {
  channel: "linkedin" | "email";
  mode: "auto" | "semi";
  delayHours?: number;
  linkedinAction?: "connect_note" | "message" | null;
  subjectTemplate?: string | null;
  bodyTemplate: string;
  emailThreadMode?: "new" | "reply" | null;
} {
  const channel = s.channel;
  return {
    channel,
    mode: channel === "linkedin" ? "semi" : s.mode === "semi" ? "semi" : "auto",
    delayHours: s.delay_hours ?? 0,
    emailThreadMode:
      channel === "email"
        ? s.email_thread_mode === "new"
          ? "new"
          : "reply"
        : null,
    linkedinAction:
      channel === "linkedin"
        ? (s.linkedin_action ?? "connect_note")
        : null,
    subjectTemplate: s.subject_template ?? null,
    bodyTemplate: s.body_template,
  };
}

export const sequenceList = tool({
  description:
    "List all outreach sequences (campaigns) with step count and active enrollments. Use before creating a campaign or to pick a sequence_id.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const client = getSupabaseServiceClient();
      const { listSequences } = await import("@/lib/outreach/sequences");
      const sequences = await listSequences(client);
      return {
        success: true as const,
        sequences: sequences.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          status: s.status,
          step_count: s.stepCount ?? 0,
          active_enrollments: s.enrollmentCount ?? 0,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceGet = tool({
  description:
    "Get one sequence in full: metadata, ordered steps (templates), and enrolled people (contacts running the campaign). Use to review or iterate on a campaign before/after enroll.",
  inputSchema: z.object({
    sequence_id: z.string(),
  }),
  execute: async ({ sequence_id }) => {
    try {
      const client = getSupabaseServiceClient();
      const { getSequence, listEnrollments } = await import(
        "@/lib/outreach/sequences"
      );
      const detail = await getSequence(client, sequence_id);
      if (!detail) {
        return { success: false as const, message: "Sequence not found" };
      }
      const enrollments = await listEnrollments(client, sequence_id);
      return {
        success: true as const,
        sequence: detail.sequence,
        steps: detail.steps.map((s) => ({
          id: s.id,
          position: s.position,
          channel: s.channel,
          mode: s.mode,
          delay_hours: s.delayHours,
          linkedin_action: s.linkedinAction,
          subject_template: s.subjectTemplate,
          body_template: s.bodyTemplate,
        })),
        people: enrollments.map((e) => ({
          id: e.id,
          status: e.status,
          company: e.companyName,
          domain: e.domain,
          name: e.contactName,
          email: e.contactEmail,
          linkedin: e.contactLinkedin,
          role: e.contactRole,
          current_step: e.currentStepPosition,
          next_run_at: e.nextRunAt,
          missing_linkedin: !e.contactLinkedin,
          missing_email: !e.contactEmail,
        })),
        people_count: enrollments.length,
        active_count: enrollments.filter((e) => e.status === "active").length,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceCreate = tool({
  description:
    "Create a fully custom outreach campaign (sequence). Pass steps[] for custom multi-channel cadence (LinkedIn connect/message + email) with body/subject templates. Prefer writing copy in the user's language (e.g. pt-BR for Brazilian ICP). " +
    TEMPLATE_TOKEN_HELP +
    " If steps omitted, uses a default EN cadence. Typical agent flow: researchListTables → researchListRows (understand ICP) → sequenceCreate with custom pt-BR steps → sequenceEnrollResearch → sequenceListQueue.",
  inputSchema: z.object({
    name: z.string().describe("Campaign name, e.g. 'QA founders BR jul/26'"),
    description: z
      .string()
      .optional()
      .describe("Internal note: ICP angle, offer, language"),
    status: z
      .enum(["draft", "active"])
      .optional()
      .describe("Default draft; set active when ready to enroll"),
    mailbox_id: z.string().optional().describe("Connected sender mailbox id for this campaign; omit to use workspace default"),
    steps: z
      .array(sequenceStepSchema)
      .optional()
      .describe(
        "Ordered cadence. Example: LI connect_note delay 0 → email auto delay 24 → LI message delay 72",
      ),
    user_email: z.string().optional(),
  }),
  execute: async ({ name, description, status, mailbox_id, steps, user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const { createSequence, updateSequence } = await import(
        "@/lib/outreach/sequences"
      );
      const result = await createSequence(client, {
        name,
        description,
        createdByEmail: user_email,
        mailboxId: mailbox_id,
        steps: steps?.map(mapStepInput),
      });
      let sequence = result.sequence;
      if (status === "active") {
        sequence = await updateSequence(client, sequence.id, {
          status: "active",
        });
      }
      return {
        success: true as const,
        sequence,
        steps: result.steps.map((s) => ({
          position: s.position,
          channel: s.channel,
          mode: s.mode,
          delay_hours: s.delayHours,
          linkedin_action: s.linkedinAction,
          subject_template: s.subjectTemplate,
          body_template: s.bodyTemplate,
        })),
        next:
          "Call sequenceEnrollResearch with this sequence_id and table_ref (list slug/id) to put people into the campaign. Then sequenceListQueue for human LinkedIn work.",
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceUpdate = tool({
  description:
    "Update sequence metadata, status, and/or replace all steps. Status is intentional and never auto-set on enroll: draft (editing), active (runs queue + email auto-send), paused (holds tasks), archived (hidden). Changing status applies immediately (pause pulls ready tasks off the queue; active releases due LinkedIn/manual work).",
  inputSchema: z.object({
    sequence_id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(["draft", "active", "paused", "archived"]).optional(),
    mailbox_id: z.string().nullable().optional(),
    steps: z.array(sequenceStepSchema).optional(),
  }),
  execute: async ({ sequence_id, name, description, status, mailbox_id, steps }) => {
    try {
      const client = getSupabaseServiceClient();
      const { updateSequence, replaceSteps, getSequence } = await import(
        "@/lib/outreach/sequences"
      );
      let sequence = (
        await getSequence(client, sequence_id)
      )?.sequence;
      if (!sequence) {
        return { success: false as const, message: "Sequence not found" };
      }
      if (
        name !== undefined ||
        description !== undefined ||
        status !== undefined
      ) {
        sequence = await updateSequence(client, sequence_id, {
          name,
          description,
          status,
          mailboxId: mailbox_id,
        });
      }
      let outSteps = (await getSequence(client, sequence_id))?.steps ?? [];
      if (steps && steps.length > 0) {
        outSteps = await replaceSteps(
          client,
          sequence_id,
          steps.map(mapStepInput),
        );
      }
      return {
        success: true as const,
        sequence,
        steps: outSteps.map((s) => ({
          position: s.position,
          channel: s.channel,
          mode: s.mode,
          delay_hours: s.delayHours,
          linkedin_action: s.linkedinAction,
          subject_template: s.subjectTemplate,
          body_template: s.bodyTemplate,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceDelete = tool({
  description:
    "Permanently delete an outreach sequence and all its steps, enrollments, and pending/sent tasks (hard delete, cascade). Prefer status=archived via sequenceUpdate if you only want to hide it. Confirm with the user before calling when enrollments > 0.",
  inputSchema: z.object({
    sequence_id: z.string(),
    confirm: z
      .boolean()
      .describe("Must be true to actually delete — safety guard for agents"),
  }),
  execute: async ({ sequence_id, confirm }) => {
    try {
      if (!confirm) {
        return {
          success: false as const,
          message:
            "Pass confirm=true to permanently delete. This removes steps, enrollments, and queue tasks.",
        };
      }
      const client = getSupabaseServiceClient();
      const { deleteSequence } = await import("@/lib/outreach/sequences");
      const result = await deleteSequence(client, sequence_id);
      return {
        success: true as const,
        ...result,
        message: `Deleted sequence "${result.name}" (${result.deletedSteps} steps, ${result.deletedEnrollments} enrollments).`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceHistory = tool({
  description:
    "List recovery snapshots for an outreach sequence. Updates, step replacements, contact removals, and deletes create snapshots automatically.",
  inputSchema: z.object({
    sequence_id: z.string(),
    limit: z.number().optional(),
  }),
  execute: async ({ sequence_id, limit }) => {
    try {
      const client = getSupabaseServiceClient();
      const { listSequenceSnapshots } = await import("@/lib/outreach/sequences");
      const snapshots = await listSequenceSnapshots(client, sequence_id, limit ?? 20);
      return { success: true as const, snapshots };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "History failed",
      };
    }
  },
});

export const sequenceRestoreSnapshot = tool({
  description:
    "Restore an outreach sequence exactly from a recovery snapshot, including steps, enrolled people, and send tasks. The current campaign is snapshotted first so this is undoable. Confirm before calling because it replaces the current campaign state.",
  inputSchema: z.object({
    snapshot_id: z.string(),
    confirm: z.boolean().describe("Must be true to perform the exact restore"),
    user_email: z.string().optional(),
  }),
  execute: async ({ snapshot_id, confirm, user_email }) => {
    if (!confirm) {
      return {
        success: false as const,
        message: "Pass confirm=true to replace the current campaign with this snapshot.",
      };
    }
    try {
      const client = getSupabaseServiceClient();
      const { restoreSequenceSnapshot } = await import("@/lib/outreach/sequences");
      const restored = await restoreSequenceSnapshot(client, snapshot_id, {
        createdBy: user_email,
      });
      return { success: true as const, ...restored };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Restore failed",
      };
    }
  },
});

export const sequencePreview = tool({
  description:
    "Preview how sequence templates render for a real person (enrollment) or a sample contact from a research list. Use before enroll to validate pt-BR copy and tokens. Returns unfilled_variables per step: any token left as {{token}} has no value and will block that send in the queue.",
  inputSchema: z.object({
    sequence_id: z.string().optional(),
    enrollment_id: z.string().optional(),
    table_ref: z
      .string()
      .optional()
      .describe("Research list to pull a sample person when not using enrollment"),
    steps: z
      .array(sequenceStepSchema)
      .optional()
      .describe("Draft steps to preview without saving (else uses sequence_id steps)"),
  }),
  execute: async ({ sequence_id, enrollment_id, table_ref, steps }) => {
    try {
      const client = getSupabaseServiceClient();
      const { renderTemplateParts } = await import("@/lib/outreach/renderer");
      const { getSequence, listEnrollments } = await import(
        "@/lib/outreach/sequences"
      );

      type Person = {
        companyName: string;
        domain: string | null;
        contactName: string | null;
        contactEmail: string | null;
        contactLinkedin: string | null;
        contactRole: string | null;
        /** Product-signal tokens, present only on a real CRM enrollment. */
        templateVars?: Record<string, string> | null;
      };

      let person: Person = {
        companyName: "Empresa Exemplo",
        domain: "exemplo.com.br",
        contactName: "Ana Silva",
        contactEmail: "ana@exemplo.com.br",
        contactLinkedin: "https://linkedin.com/in/ana-silva",
        contactRole: "Head of Engineering",
      };
      let person_source = "sample_pt";

      // enrollment_id used to require sequence_id alongside it, so previewing
      // draft steps for a real person — steps + enrollment_id, no sequence yet
      // — silently fell through to the sample contact below. The preview then
      // showed every product token unfilled and read as proof the tokens were
      // broken, when nothing had looked the enrollment up at all.
      if (enrollment_id) {
        let e = null as Awaited<ReturnType<typeof listEnrollments>>[number] | null;
        if (sequence_id) {
          const people = await listEnrollments(client, sequence_id);
          e = people.find((p) => p.id === enrollment_id) ?? null;
        }
        if (!e) {
          const { data: row } = await client
            .from("outreach_enrollments")
            .select("*")
            .eq("id", enrollment_id)
            .maybeSingle();
          if (row) {
            const { mapEnrollment } = await import("@/lib/outreach/sequences");
            e = mapEnrollment(row as Record<string, unknown>);
          }
        }
        if (e) {
          person = {
            companyName: e.companyName,
            domain: e.domain,
            contactName: e.contactName,
            contactEmail: e.contactEmail,
            contactLinkedin: e.contactLinkedin,
            contactRole: e.contactRole,
            // Without this every product token previewed as unfilled, even for
            // an enrollment that carries the values.
            templateVars: e.templateVars,
          };
          person_source = "enrollment";
        }
      } else if (table_ref) {
        const { resolveTable } = await import("@/lib/research/columns");
        const { listRows, listPeople } = await import("@/lib/research/tables");
        const table = await resolveTable(client, table_ref);
        const rows = await listRows(client, table.id);
        for (const row of rows.slice(0, 20)) {
          const people = await listPeople(client, row.id);
          const p =
            people.find((x) => x.linkedin || x.email) ?? people[0];
          if (p) {
            person = {
              companyName: row.companyName,
              domain: row.domain,
              contactName: p.name,
              contactEmail: p.email,
              contactLinkedin: p.linkedin,
              contactRole: p.role,
              templateVars: Object.fromEntries(
                Object.entries(row.cells ?? {})
                  .filter(([, cell]) =>
                    cell.value != null && typeof cell.value !== "object",
                  )
                  .map(([key, cell]) => [key, String(cell.value)]),
              ),
            };
            person_source = `research:${table.slug ?? table.id}`;
            break;
          }
        }
      }

      let stepDefs: Array<{
        channel: string;
        mode: string;
        delayHours: number;
        linkedinAction: string | null;
        subjectTemplate: string | null;
        bodyTemplate: string;
      }> = [];

      if (steps?.length) {
        stepDefs = steps.map((s) => {
          const m = mapStepInput(s);
          return {
            channel: m.channel,
            mode: m.mode,
            delayHours: m.delayHours ?? 0,
            linkedinAction: m.linkedinAction ?? null,
            subjectTemplate: m.subjectTemplate ?? null,
            bodyTemplate: m.bodyTemplate,
          };
        });
      } else if (sequence_id) {
        const detail = await getSequence(client, sequence_id);
        if (!detail) {
          return { success: false as const, message: "Sequence not found" };
        }
        stepDefs = detail.steps.map((s) => ({
          channel: s.channel,
          mode: s.mode,
          delayHours: s.delayHours,
          linkedinAction: s.linkedinAction,
          subjectTemplate: s.subjectTemplate,
          bodyTemplate: s.bodyTemplate,
        }));
      } else {
        return {
          success: false as const,
          message: "Provide sequence_id or steps[] to preview",
        };
      }

      const rendered = stepDefs.map((s, i) => {
        const subject = s.subjectTemplate
          ? renderTemplateParts(s.subjectTemplate, person)
          : null;
        const body = renderTemplateParts(s.bodyTemplate, person);
        // An unfilled token blocks the send at queue time, so the preview has
        // to name it here — otherwise the copy reads fine and the campaign
        // silently jams once it is enrolled.
        const unfilled = [
          ...new Set([...(subject?.missing ?? []), ...body.missing]),
        ];
        return {
          position: i,
          channel: s.channel,
          mode: s.mode,
          delay_hours: s.delayHours,
          linkedin_action: s.linkedinAction,
          subject: subject?.text ?? null,
          body: body.text,
          unfilled_variables: unfilled,
          gaps: [
            s.channel === "linkedin" && !person.contactLinkedin
              ? "missing_linkedin"
              : null,
            s.channel === "email" && !person.contactEmail
              ? "missing_email"
              : null,
            unfilled.length > 0 ? "unfilled_variables" : null,
          ].filter(Boolean),
        };
      });

      const anyUnfilled = rendered.some(
        (r) => r.unfilled_variables.length > 0,
      );

      return {
        success: true as const,
        person_source,
        person,
        steps: rendered,
        note: anyUnfilled
          ? person_source === "enrollment"
            ? "Tokens left as {{token}} have no value for this enrollment — the queue will block those sends. Rewrite the copy or fix the account data."
            : "Tokens left as {{token}} are unfilled for this preview contact. Product tokens (signup_date, trial_days_left, …) only resolve on CRM enrollments — preview with enrollment_id to check them for real."
          : undefined,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceRefreshResearchVars = tool({
  description:
    "Refresh research-list template variables such as {{public_trigger}} on active research enrollments and re-render unsent tasks. Use after adding a research variable/column or when queued copy still shows an unresolved research token.",
  inputSchema: z.object({
    sequence_id: z
      .string()
      .optional()
      .describe("Optional sequence id. Omit to refresh active research enrollments across campaigns."),
    limit: z.number().optional().describe("Max enrollments to inspect."),
  }),
  execute: async ({ sequence_id, limit }) => {
    try {
      const client = getSupabaseServiceClient();
      const { refreshResearchTemplateVars } = await import(
        "@/lib/outreach/sequences"
      );
      const result = await refreshResearchTemplateVars(client, {
        sequenceId: sequence_id,
        limit,
      });
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceEnrollResearch = tool({
  description:
    "Enroll people from a research ICP list into a sequence. Creates send tasks for step 1 but does NOT auto-activate — if the sequence is draft/paused/archived, tasks stay held until status is set to active via sequenceUpdate. Returns enrolled/skipped counts, missing LinkedIn/email warnings, and sequenceStatus. Use table_ref = list slug or id from researchListTables.",
  inputSchema: z.object({
    sequence_id: z.string(),
    table_ref: z.string().describe("Research table id or slug"),
    row_ids: z.array(z.string()).optional(),
    all_people: z
      .boolean()
      .optional()
      .describe("Enroll every person per company (default true)"),
    user_email: z.string().optional(),
  }),
  execute: async ({
    sequence_id,
    table_ref,
    row_ids,
    all_people,
    user_email,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const { enrollFromResearch } = await import("@/lib/outreach/sequences");
      const result = await enrollFromResearch(client, {
        sequenceId: sequence_id,
        tableRef: table_ref,
        rowIds: row_ids,
        allPeople: all_people !== false,
        enrolledByEmail: user_email ?? null,
      });
      return {
        success: true as const,
        ...result,
        next:
          result.sequenceStatus === "active"
            ? "Sequence is active. Use sequenceListQueue for LinkedIn/manual tasks. Email auto-send depends on Settings → mailbox email_auto_send."
            : `Sequence is "${result.sequenceStatus}" — people are enrolled but work is held. Call sequenceUpdate with status="active" when ready to run the campaign.`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceEnrollCrm = tool({
  description:
    "Enroll CRM accounts (companies + their contacts with email) into an outreach sequence. This is the entry path for product-signal tiers: filter accounts with listCrmCompanies (e.g. tier=t0, prep_status='ready') then enroll their ids here. Suppression built in: ONLY accounts whose prep_status is 'ready' can be enrolled — every not_started/enriched/parked account is refused, so enrolling without that filter reports mostly skips. Customer/churned/lost accounts are skipped too, and accounts already active in another sequence are skipped unless allow_parallel=true. The prep gate lives on the CRM account (crm_companies.prep_status), not on research tables. Does NOT auto-activate the sequence.",
  inputSchema: z.object({
    sequence_id: z.string(),
    company_ids: z.array(z.string()).min(1).describe("CRM company ids from listCrmCompanies"),
    all_contacts: z
      .boolean()
      .optional()
      .describe("Enroll every contact with email per company (default: primary contact only)"),
    allow_parallel: z
      .boolean()
      .optional()
      .describe("Enroll even if the account is already active in another sequence"),
    user_email: z.string().optional(),
  }),
  execute: async ({
    sequence_id,
    company_ids,
    all_contacts,
    allow_parallel,
    user_email,
  }) => {
    try {
      const client = getSupabaseServiceClient();
      const { enrollFromCrm } = await import("@/lib/outreach/sequences");
      const result = await enrollFromCrm(client, {
        sequenceId: sequence_id,
        companyIds: company_ids,
        allContacts: all_contacts ?? false,
        allowParallel: allow_parallel ?? false,
        enrolledByEmail: user_email ?? null,
      });
      return {
        success: true as const,
        ...result,
        next:
          result.sequenceStatus === "active"
            ? "Sequence is active. Use sequenceListQueue for the human queue; email auto-send depends on the mailbox setting."
            : `Sequence is "${result.sequenceStatus}" — accounts enrolled but work is held. Call sequenceUpdate with status="active" when ready.`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceUnenroll = tool({
  description:
    "Remove specific people or companies from an outreach sequence. It cancels active/paused enrollments and their pending tasks, while preserving completed and sent-task history. Use enrollment_ids, research_person_ids, or research_row_ids; do not delete the whole sequence. Confirm before bulk removal.",
  inputSchema: z
    .object({
      sequence_id: z.string(),
      enrollment_ids: z.array(z.string()).min(1).optional(),
      research_person_ids: z.array(z.string()).min(1).optional(),
      research_row_ids: z.array(z.string()).min(1).optional(),
      confirm: z
        .boolean()
        .describe("Must be true to cancel the selected enrollments and pending tasks"),
    })
    .refine(
      (input) =>
        Boolean(
          input.enrollment_ids?.length ||
            input.research_person_ids?.length ||
            input.research_row_ids?.length,
        ),
      "Provide enrollment_ids, research_person_ids, or research_row_ids",
    ),
  execute: async ({
    sequence_id,
    enrollment_ids,
    research_person_ids,
    research_row_ids,
    confirm,
  }) => {
    try {
      if (!confirm) {
        return {
          success: false as const,
          message:
            "Pass confirm=true to cancel the selected enrollments and their pending tasks.",
        };
      }
      const client = getSupabaseServiceClient();
      const { unenrollFromSequence } = await import(
        "@/lib/outreach/sequences"
      );
      const result = await unenrollFromSequence(client, {
        sequenceId: sequence_id,
        enrollmentIds: enrollment_ids,
        researchPersonIds: research_person_ids,
        researchRowIds: research_row_ids,
      });
      return {
        success: true as const,
        ...result,
        message: `Removed ${result.cancelled} enrollment(s) and cancelled ${result.pendingTasksCancelled} pending task(s).`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

export const sequenceListQueue = tool({
  description:
    "List ready Today-queue tasks (LinkedIn semi + manual email). After campaign enroll, call this to work the human queue. Returns copy-ready body/subject and LinkedIn URLs.",
  inputSchema: z.object({
    channel: z.enum(["linkedin", "email"]).optional(),
    limit: z.number().optional(),
  }),
  execute: async ({ channel, limit }) => {
    try {
      const client = getSupabaseServiceClient();
      const {
        listReadyQueue,
        processDueSequenceTasks,
        getActivityStats,
      } = await import("@/lib/outreach/sequences");
      await processDueSequenceTasks(client);
      const tasks = await listReadyQueue(client, {
        channel,
        limit: limit ?? 40,
      });
      const stats = await getActivityStats(client);
      return {
        success: true as const,
        stats,
        tasks: tasks.map((t) => ({
          id: t.id,
          channel: t.channel,
          mode: t.mode,
          body: t.renderedBody,
          subject: t.renderedSubject,
          company: t.enrollment?.companyName,
          contact: t.enrollment?.contactName,
          email: t.enrollment?.contactEmail,
          linkedin: t.enrollment?.contactLinkedin,
          role: t.enrollment?.contactRole,
          action: t.step?.linkedinAction,
          sequence: t.sequenceName,
          how_to:
            t.channel === "linkedin"
              ? "Open LinkedIn URL → paste body → send → sequenceCompleteTask outcome=sent"
              : "Open Gmail with subject/body → send → sequenceCompleteTask outcome=sent",
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

/**
 * Sending is outward-facing and has no undo, so both send tools preview by
 * default and only fire when the caller passes dry_run: false. An ambiguous
 * instruction mid-conversation should cost a preview, not a message in a
 * prospect's inbox.
 */
const DRY_RUN_HELP =
  "Preview only — returns exactly what would be sent, sends nothing. Default true. Pass false to actually send.";

export const outreachSendQueuedTask = tool({
  description:
    "Send a queued outreach step for real, on either channel — email via Gmail, LinkedIn via Unipile. Goes through the same path the cron and the Today-queue button use: checked claim against double-send, unfilled-{{token}} guard, threading, daily cap, CRM timeline, reply-inbox linkage. Optionally replaces the copy for this one send without touching the step template. Previews by default; pass dry_run: false to send. Use sequenceListQueue first to pick a task_id.",
  inputSchema: z.object({
    task_id: z.string().describe("Task id from sequenceListQueue"),
    subject: z
      .string()
      .optional()
      .describe("Email only: replace the subject for this send"),
    body: z
      .string()
      .optional()
      .describe("Replace the body for this send (this task only)"),
    dry_run: z.boolean().optional().describe(DRY_RUN_HELP),
    user_email: z
      .string()
      .optional()
      .describe("Who is sending, for the CRM timeline"),
  }),
  execute: async ({ task_id, subject, body, dry_run, user_email }) => {
    try {
      const client = getSupabaseServiceClient();

      const { data: taskRow } = await client
        .from("outreach_send_tasks")
        .select(
          "id, channel, status, scheduled_for, rendered_subject, rendered_body, enrollment_id, step_id, error",
        )
        .eq("id", task_id)
        .maybeSingle();
      if (!taskRow) {
        return { success: false as const, message: "Task not found" };
      }

      const { data: enr } = await client
        .from("outreach_enrollments")
        .select("company_name, contact_name, contact_email, contact_linkedin, status")
        .eq("id", taskRow.enrollment_id as string)
        .maybeSingle();

      const channel = taskRow.channel as string;
      const finalSubject = subject ?? (taskRow.rendered_subject as string | null);
      const finalBody = body ?? (taskRow.rendered_body as string | null);
      const recipient =
        channel === "linkedin"
          ? (enr?.contact_linkedin as string | null)
          : (enr?.contact_email as string | null);

      // The preview is the whole safety story here — it must show the copy
      // that would actually leave, edits included, not the stored template.
      const preview = {
        task_id,
        channel,
        task_status: taskRow.status,
        enrollment_status: enr?.status ?? null,
        to: recipient,
        contact_name: (enr?.contact_name as string | null) ?? null,
        company: (enr?.company_name as string | null) ?? null,
        subject: finalSubject,
        body: finalBody,
        edited: Boolean(subject !== undefined || body !== undefined),
        blocked_reason: (taskRow.error as string | null) ?? null,
      };

      // A preview that ends in "call again to send this" is a lie when the
      // send path would refuse the task outright. Say so before the caller
      // confirms, not after.
      const refusal =
        taskRow.status === "sent"
          ? "already sent"
          : taskRow.status !== "ready" && taskRow.status !== "scheduled"
            ? `task is ${taskRow.status}`
            : enr && enr.status !== "active"
              ? `enrollment is ${enr.status}`
              : null;

      if (dry_run !== false) {
        return {
          success: true as const,
          dry_run: true as const,
          sent: false as const,
          message: refusal
            ? `Nothing sent — and a real send would be refused: ${refusal}.`
            : "Nothing sent. Call again with dry_run: false to send this.",
          would_send: !refusal,
          refusal,
          preview,
        };
      }

      if (!recipient) {
        return {
          success: false as const,
          message:
            channel === "linkedin"
              ? "This enrollment has no contact LinkedIn"
              : "This enrollment has no contact email",
          preview,
        };
      }

      const { sendTaskNow } = await import("@/lib/outreach/sequences");
      const result = await sendTaskNow(client, task_id, {
        sentByEmail: user_email ?? null,
        subject,
        body,
      });

      return {
        success: result.ok,
        dry_run: false as const,
        sent: result.ok,
        status: result.status,
        message: result.ok
          ? `Sent on ${channel} to ${recipient}`
          : (result.error ?? "Send failed"),
        preview,
      };
    } catch (error) {
      return {
        success: false as const,
        sent: false as const,
        message: error instanceof Error ? error.message : "Failed to send",
      };
    }
  },
});

export const outreachSendLinkedInMessage = tool({
  description:
    "Send a one-off LinkedIn message or connection request through the connected Unipile account, outside any sequence. Replies in the existing conversation with that person when there is one, otherwise opens a new chat. Previews by default; pass dry_run: false to send. For a step that is already queued, use outreachSendQueuedTask instead — it records the send against the cadence, which this does not.",
  inputSchema: z.object({
    linkedin: z
      .string()
      .optional()
      .describe(
        "Profile URL, vanity slug, or ACoAA… member id. Omit only when passing chat_id.",
      ),
    chat_id: z
      .string()
      .optional()
      .describe("Unipile chat id, to reply in a known conversation"),
    text: z.string().describe("Message body (the note, for connect_note)"),
    action: z
      .enum(["message", "connect_note"])
      .optional()
      .describe(
        "message = DM (default); connect_note = connection request with a note. A DM to a non-connection is often rejected by LinkedIn.",
      ),
    account_id: z
      .string()
      .optional()
      .describe("Unipile account id; defaults to the first LinkedIn account"),
    dry_run: z.boolean().optional().describe(DRY_RUN_HELP),
  }),
  execute: async ({ linkedin, chat_id, text, action, account_id, dry_run }) => {
    try {
      if (!text?.trim()) {
        return { success: false as const, message: "text is empty" };
      }
      if (!linkedin?.trim() && !chat_id?.trim()) {
        return {
          success: false as const,
          message: "Pass linkedin (profile URL or slug) or chat_id",
        };
      }

      const {
        isUnipileConfigured,
        listLinkedInAccounts,
        normalizeLinkedInIdentity,
        isLinkedInProviderId,
        getUnipileUserProfile,
        findUnipileChatByAttendee,
        sendUnipileChatMessage,
        startUnipileChat,
        sendLinkedInInvitation,
      } = await import("@/lib/unipile");

      if (!isUnipileConfigured()) {
        return {
          success: false as const,
          message: "Unipile is not configured (UNIPILE_API_KEY / UNIPILE_DSN)",
        };
      }

      let accountId = account_id?.trim() || null;
      if (!accountId) {
        const accounts = await listLinkedInAccounts();
        if (!accounts.length) {
          return {
            success: false as const,
            message: "No LinkedIn account connected in Unipile",
          };
        }
        accountId = accounts[0].id;
      }

      const mode = action ?? "message";

      // Resolve the recipient before the dry-run answer: "who would this go
      // to" is the question the preview exists to answer, and a slug that
      // resolves to nobody must surface now, not after the caller confirms.
      let providerId: string | null = null;
      let profileUrl: string | null = null;
      let name: string | null = null;
      if (linkedin?.trim()) {
        const slug = normalizeLinkedInIdentity(linkedin);
        if (!slug) {
          return {
            success: false as const,
            message: `Unreadable LinkedIn identity: ${linkedin}`,
          };
        }
        if (isLinkedInProviderId(slug)) {
          providerId = slug;
        } else {
          const profile = await getUnipileUserProfile({
            accountId,
            identifier: slug,
          });
          providerId = profile?.providerId ?? null;
          profileUrl = profile?.profileUrl ?? null;
          name = [profile?.firstName, profile?.lastName]
            .filter(Boolean)
            .join(" ") || null;
        }
        if (!providerId) {
          return {
            success: false as const,
            message: `Could not resolve a LinkedIn member id for ${slug}`,
          };
        }
      }

      let targetChatId = chat_id?.trim() || null;
      if (!targetChatId && providerId && mode === "message") {
        targetChatId = await findUnipileChatByAttendee({
          accountId,
          providerId,
        });
      }

      const preview = {
        action: mode,
        account_id: accountId,
        provider_id: providerId,
        profile_url: profileUrl,
        name,
        // Which of the three sends this becomes — a new chat with a stranger
        // reads very differently from a reply, and the caller should see which.
        resolves_to:
          mode === "connect_note"
            ? "connection request with note"
            : targetChatId
              ? "reply in existing conversation"
              : "new conversation",
        chat_id: targetChatId,
        text,
      };

      if (dry_run !== false) {
        return {
          success: true as const,
          dry_run: true as const,
          sent: false as const,
          message: "Nothing sent. Call again with dry_run: false to send this.",
          preview,
        };
      }

      if (mode === "connect_note") {
        if (!providerId) {
          return {
            success: false as const,
            message: "A connection request needs linkedin, not chat_id",
          };
        }
        const invite = await sendLinkedInInvitation({
          accountId,
          providerId,
          message: text,
        });
        return {
          success: true as const,
          dry_run: false as const,
          sent: true as const,
          invitation_id: invite.invitationId,
          preview,
        };
      }

      if (targetChatId) {
        const sent = await sendUnipileChatMessage({
          chatId: targetChatId,
          text,
          accountId,
        });
        return {
          success: true as const,
          dry_run: false as const,
          sent: true as const,
          chat_id: targetChatId,
          message_id: sent.messageId,
          preview,
        };
      }

      const started = await startUnipileChat({
        accountId,
        attendeeProviderIds: [providerId!],
        text,
      });
      return {
        success: true as const,
        dry_run: false as const,
        sent: true as const,
        chat_id: started.chatId,
        message_id: started.messageId,
        preview,
      };
    } catch (error) {
      return {
        success: false as const,
        sent: false as const,
        message: error instanceof Error ? error.message : "LinkedIn send failed",
      };
    }
  },
});

export const sequenceCompleteTask = tool({
  description:
    "Mark a Today-queue task as sent or skipped after the human (or agent-assisted) send. Advances enrollment to the next step.",
  inputSchema: z.object({
    task_id: z.string(),
    outcome: z.enum(["sent", "skipped"]).optional(),
    user_email: z.string().optional(),
  }),
  execute: async ({ task_id, outcome, user_email }) => {
    try {
      const client = getSupabaseServiceClient();
      const { completeTask } = await import("@/lib/outreach/sequences");
      const result = await completeTask(client, task_id, {
        outcome: outcome ?? "sent",
        sentByEmail: user_email ?? null,
      });
      return {
        success: true as const,
        task_status: result.task.status,
        enrollment_status: result.enrollment?.status,
        next_step: result.enrollment?.currentStepPosition,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Failed",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// LinkedIn comment harvesting
// ---------------------------------------------------------------------------

export const linkedinFindPosts = tool({
  description:
    "Find LinkedIn posts about a topic via Exa and return their activity ids. Discovery only — makes no call against the connected LinkedIn account, so it is cheap and safe to run while exploring topics. Use it to see what conversations exist before spending account calls on linkedinListPostCommenters or linkedinHarvestCommenters. Posts whose URL carries no activity id come back with activityId=null and cannot be harvested.",
  inputSchema: z.object({
    queries: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        "Topic queries to search LinkedIn for, e.g. ['AI code review', 'PR review bottleneck']. Each one is a paid Exa search, so at most 10. Omit to use the standard Kodus monitoring topics.",
      ),
    daysBack: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .default(14)
      .describe("How far back to search (default 14 days)."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(25)
      .describe("Max posts to return (default 25)."),
  }),
  execute: async ({
    queries,
    daysBack,
    maxResults,
  }: {
    queries?: string[];
    daysBack?: number;
    maxResults?: number;
  }) => {
    try {
      const { findLinkedInPosts } = await import("@/lib/linkedin-harvest");
      const posts = await findLinkedInPosts({ queries, daysBack, maxResults });
      return {
        success: true as const,
        count: posts.length,
        harvestable: posts.filter((p) => p.activityId).length,
        posts,
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "LinkedIn post search failed",
      };
    }
  },
});

export const linkedinListPostCommenters = tool({
  description:
    "List everyone who commented on one LinkedIn post, with their headline (role) and network distance. Runs against the connected LinkedIn account, so it is paced and capped — keep maxComments small. networkDistance decides routing: DISTANCE_1 is a first-degree connection and belongs in a direct message from the founder, DISTANCE_2/3 belong in the cold queue. Accepts a post URL or a bare activity id. Read-only — writes nothing.",
  inputSchema: z.object({
    postUrl: z
      .string()
      .optional()
      .describe(
        "Full LinkedIn post URL, e.g. https://www.linkedin.com/posts/name_slug-activity-7462609441322926081-QQwC",
      ),
    activityId: z
      .string()
      .optional()
      .describe("Bare numeric activity id, if you already extracted it."),
    accountId: z
      .string()
      .optional()
      .describe(
        "Unipile account id to read through. Defaults to the connected LinkedIn account.",
      ),
    includeReplies: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Also walk replies to comments (costs extra account calls). Replies are collected only after top-level comments and share the same maxComments budget, so raise maxComments to reach them. Default false.",
      ),
    maxComments: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(25)
      .describe("Max commenters to return (default 25, deliberately small)."),
  }),
  execute: async ({
    postUrl,
    activityId,
    accountId,
    includeReplies,
    maxComments,
  }: {
    postUrl?: string;
    activityId?: string;
    accountId?: string;
    includeReplies?: boolean;
    maxComments?: number;
  }) => {
    try {
      const ref = postUrl?.trim() || activityId?.trim();
      if (!ref) {
        return {
          success: false as const,
          message: "Pass either postUrl or activityId.",
        };
      }
      const { listPostCommenters } = await import("@/lib/linkedin-harvest");
      const res = await listPostCommenters({
        postUrlOrActivityId: ref,
        accountId,
        includeReplies,
        maxComments,
      });
      return {
        success: true as const,
        post_url: res.postUrl,
        activity_id: res.activityId,
        social_id: res.socialId,
        post_author: res.postAuthor,
        count: res.commenters.length,
        commenters: res.commenters.map((c) => ({
          name: c.name,
          profileUrl: c.profileUrl,
          headline: c.headline,
          networkDistance: c.networkDistance,
          commentText: c.commentText,
          commentedAt: c.commentedAt,
          postUrl: c.postUrl,
          // A company page can comment. Shown rather than hidden, so a brand
          // account is never mistaken for a person to contact.
          isCompany: c.isCompany,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Failed to list commenters",
      };
    }
  },
});

export const linkedinHarvestCommenters = tool({
  description:
    "Run the whole chain: find LinkedIn posts on a topic, then collect who commented on them with role and network distance. Returns summary counts plus the people. Use this to turn a topic into a dated, quotable trigger attached to a named human — strictly better than a company with a job opening. Writes nothing unless researchTableRef is passed; with it, people are deduped on profile URL and each comment is stored as a trigger carrying the post URL, comment text and comment date. Drives the real connected LinkedIn account: maxPosts and maxCommentsPerPost default small on purpose, raise them only deliberately.",
  inputSchema: z.object({
    queries: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        "Topic queries, e.g. ['AI code review', 'code review bottleneck']. Each one is a paid Exa search, so at most 10. Omit to use the standard Kodus monitoring topics.",
      ),
    daysBack: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .default(14)
      .describe("How far back to search for posts (default 14 days)."),
    maxPosts: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .default(3)
      .describe(
        "Max posts to harvest (default 3). Each post costs at least two account calls.",
      ),
    maxCommentsPerPost: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(25)
      .describe("Max commenters per post (default 25)."),
    includeReplies: z
      .boolean()
      .optional()
      .default(false)
      .describe("Also walk replies to comments. Default false."),
    accountId: z
      .string()
      .optional()
      .describe(
        "Unipile account id. Defaults to the connected LinkedIn account.",
      ),
    researchTableRef: z
      .string()
      .optional()
      .describe(
        "Research table id, slug, or name to store the harvested people in. OMIT to preview without writing anything.",
      ),
  }),
  execute: async ({
    queries,
    daysBack,
    maxPosts,
    maxCommentsPerPost,
    includeReplies,
    accountId,
    researchTableRef,
  }: {
    queries?: string[];
    daysBack?: number;
    maxPosts?: number;
    maxCommentsPerPost?: number;
    includeReplies?: boolean;
    accountId?: string;
    researchTableRef?: string;
  }) => {
    try {
      // Only reach for Supabase when there is something to write, so a
      // preview run needs nothing but Exa and the LinkedIn account.
      let client = null as ReturnType<typeof getSupabaseServiceClient> | null;
      let researchTableId: string | null = null;
      let tableSlug: string | null = null;
      if (researchTableRef?.trim()) {
        client = getSupabaseServiceClient();
        const { resolveTable } = await import("@/lib/research/columns");
        const table = await resolveTable(client, researchTableRef.trim());
        researchTableId = table.id;
        tableSlug = table.slug;
      }

      const { harvestCommenters } = await import("@/lib/linkedin-harvest");
      const res = await harvestCommenters(client, {
        queries,
        daysBack,
        maxPosts,
        maxCommentsPerPost,
        includeReplies,
        accountId,
        researchTableId,
      });

      return {
        success: true as const,
        wrote_to_table: researchTableId ? (tableSlug ?? researchTableId) : null,
        summary: {
          posts_found: res.postsFound,
          posts_with_activity_id: res.postsWithActivityId,
          posts_processed: res.postsProcessed,
          posts_skipped: res.postsSkipped.length,
          comments_seen: res.commentsSeen,
          excluded_companies: res.excludedCompanies,
          excluded_no_identity: res.excludedNoIdentity,
          unique_people: res.uniquePeople,
          by_network_distance: res.byNetworkDistance,
          unipile_calls: res.unipileCalls,
          ...(res.written
            ? {
                people_upserted: res.written.peopleUpserted,
                people_new: res.written.peopleNew,
                triggers_added: res.written.triggersAdded,
              }
            : {}),
        },
        skipped: res.postsSkipped,
        people: res.people.map((c) => ({
          name: c.name,
          profileUrl: c.profileUrl,
          headline: c.headline,
          networkDistance: c.networkDistance,
          commentText: c.commentText,
          commentedAt: c.commentedAt,
          postUrl: c.postUrl,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Harvest failed",
      };
    }
  },
});

export function createAgentTools(userEmail?: string) {
  return {
    generateIdeas,
    generateContentPlan,
    generateKeywords: createGenerateKeywordsTool(userEmail),
    getKeywordHistory,
    generateTitles: createGenerateTitlesTool(userEmail),
    generateArticle: createGenerateArticleTool(userEmail),
    generateSocialPosts: createGenerateSocialPostsTool(userEmail),
    listSocialAccounts: createListSocialAccountsTool(userEmail),
    scheduleSocialPost: createScheduleSocialPostTool(userEmail),
    fetchBlogFeed,
    getSearchPerformance,
    getTrafficOverview,
    getTopContent,
    getContentOpportunities,
    comparePerformance,
    getContentDecay,
    getSearchBySegment,
    getPageKeywords,
    analyzeCompetitor,
    searchWeb,
    scrapePage,
    findUnlinkedBrandMentions: findUnlinkedBrandMentionsTool,
    scheduleJob,
    scheduleArticlePublication,
    listScheduledJobs,
    deleteScheduledJob,
    getVoicePolicy: createVoicePolicyTool(userEmail),
    getKeywordVolume,
    analyzeSERP,
    exploreDataWarehouse,
    runBigQuery,
    exploreTelemetry,
    listTelemetryInstances,
    getTelemetryInstance,
    runTelemetryQuery,
    createKanbanCard: createKanbanCardTool(userEmail),
    moveKanbanCard: createMoveKanbanCardTool(userEmail),
    updateKanbanCard: createUpdateKanbanCardTool(userEmail),
    deleteKanbanCard: createDeleteKanbanCardTool(userEmail),
    listKanbanCards,
    listGoals: listGoalsTool,
    createGoal: createCreateGoalTool(userEmail),
    listBets: listBetsTool,
    getFunnel: getFunnelTool,
    listAiPrompts: listAiPromptsTool,
    createAiPrompt: createAiPromptTool,
    updateAiPrompt: updateAiPromptTool,
    deleteAiPrompt: deleteAiPromptTool,
    runAiVisibility: runAiVisibilityTool,
    getAiVisibilitySettings: getAiVisibilitySettingsTool,
    updateAiVisibilitySettings: updateAiVisibilitySettingsTool,
    updateBet: updateBetTool,
    deleteBet: deleteBetTool,
    createBet: createBetTool,
    decideBet: decideBetTool,
    updateGoal: updateGoalTool,
    deleteGoal: deleteGoalTool,
    incrementGoalProgress: incrementGoalProgressTool,
    linkGoalToTask: createLinkGoalToTaskTool(userEmail),
    unlinkGoalFromTask: unlinkGoalFromTaskTool,
    listGoalLinks: listGoalLinksTool,
    listSocialMentions,
    listCrmCompanies,
    getCrmCompany,
    enrichCrmCompanyContacts,
    createCrmContact,
    updateCrmContact,
    archiveCrmContact,
    createCrmCompany,
    updateCrmCompany,
    archiveCrmCompany,
    restoreCrmCompany,
    listCrmFields,
    createCrmField,
    updateCrmField,
    deleteCrmField,
    addCrmComment,
    logCrmOutreach: createLogCrmOutreachTool(userEmail),
    crmGetCompanyEmails,
    researchListTables,
    researchCreateTable,
    researchCreateFromIcp,
    researchAddDomains,
    researchCompany,
    researchListRows,
    researchMoveRows,
    researchDeleteRows,
    researchExclusions,
    researchListHistory,
    researchRestoreListSnapshot,
    // researchSplitByRules kept in codebase for rare advanced use but NOT
    // registered on the agent — product primitive is move by row_ids only.
    researchFindIcp,
    researchEnrichPeople,
    researchSetPersonas,
    researchGetTable,
    researchCreateColumn,
    researchUpdateColumn,
    researchDeleteColumn,
    researchRunColumn,
    researchSetCell,
    researchUpsertPeople,
    researchPeopleHistory,
    researchRestorePeople,
    outreachListMailboxes,
    outreachListReplyThreads,
    sequenceList,
    sequenceGet,
    sequenceCreate,
    sequenceUpdate,
    sequenceHistory,
    sequenceRestoreSnapshot,
    sequenceDelete,
    sequencePreview,
    sequenceRefreshResearchVars,
    sequenceEnrollResearch,
    sequenceEnrollCrm,
    sequenceUnenroll,
    sequenceListQueue,
    sequenceCompleteTask,
    outreachSendQueuedTask,
    outreachSendLinkedInMessage,
    linkedinFindPosts,
    linkedinListPostCommenters,
    linkedinHarvestCommenters,
  };
}

export const agentTools = createAgentTools();
