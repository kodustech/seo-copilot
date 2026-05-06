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
import { getSupabaseServiceClient } from "@/lib/supabase-server";
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
      return { success: true as const, ...describeDataset(dataset) };
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
    scheduleJob,
    scheduleArticlePublication,
    listScheduledJobs,
    deleteScheduledJob,
    getVoicePolicy: createVoicePolicyTool(userEmail),
    getKeywordVolume,
    analyzeSERP,
    exploreDataWarehouse,
    runBigQuery,
    createKanbanCard: createKanbanCardTool(userEmail),
    moveKanbanCard: createMoveKanbanCardTool(userEmail),
    updateKanbanCard: createUpdateKanbanCardTool(userEmail),
    deleteKanbanCard: createDeleteKanbanCardTool(userEmail),
    listKanbanCards,
    listGoals: listGoalsTool,
    createGoal: createCreateGoalTool(userEmail),
    updateGoal: updateGoalTool,
    deleteGoal: deleteGoalTool,
    incrementGoalProgress: incrementGoalProgressTool,
    linkGoalToTask: createLinkGoalToTaskTool(userEmail),
    unlinkGoalFromTask: unlinkGoalFromTaskTool,
    listGoalLinks: listGoalLinksTool,
  };
}

export const agentTools = createAgentTools();
