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
import { searchIdeas, searchCompetitorContent } from "@/lib/exa";
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
} from "@/lib/bigquery";
import { getModel } from "@/lib/ai/provider";
import { CONTENT_PLAN_SYNTHESIS_PROMPT } from "@/lib/ai/system-prompt";

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
    "Fetches keyword history researched previously. Fast operation.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const keywords = await fetchKeywordsHistory();
      return {
        success: true as const,
        keywords: keywords.map((kw) => ({
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
        .default("professional")
        .describe("Tom dos posts (professional, casual, bold)"),
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
    execute: async ({ baseContent, instructions, language, tone, platforms }) => {
      try {
        const voicePolicy = await resolveVoicePolicyForUser(userEmail);
        const posts = await generateSocialContent({
          baseContent,
          instructions,
          language,
          tone,
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
    scheduleJob,
    scheduleArticlePublication,
    listScheduledJobs,
    deleteScheduledJob,
  };
}

export const agentTools = createAgentTools();
