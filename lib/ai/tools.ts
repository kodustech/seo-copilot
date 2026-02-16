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
  fetchBlogPosts,
} from "@/lib/copilot";
import { searchIdeas, searchCompetitorContent } from "@/lib/exa";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import {
  createJob,
  listJobsByEmail,
  deleteJob,
  SCHEDULE_PRESETS,
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

const WORDPRESS_API_BASE =
  process.env.WORDPRESS_API_BASE?.replace(/\/$/, "") ||
  "https://kodus.io/wp-json/wp/v2";

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
    "Pesquisa discussoes reais em Reddit, dev.to, HackerNews, StackOverflow, Twitter/X, Medium, Hashnode e LinkedIn para descobrir ideias de conteudo baseadas em 5 angulos: dores, perguntas, tendencias, comparacoes e boas praticas. (~5-10s)",
  inputSchema: z.object({
    topic: z.string().describe("Tema ou nicho para pesquisar ideias"),
    sources: z
      .array(z.string())
      .optional()
      .describe(
        "Dominios para buscar (default: reddit.com, dev.to, news.ycombinator.com, stackoverflow.com, x.com, medium.com, hashnode.dev, linkedin.com)",
      ),
    daysBack: z
      .number()
      .min(7)
      .max(365)
      .optional()
      .default(90)
      .describe("Periodo em dias para buscar (7-365, default 90)"),
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
            : "Erro ao pesquisar ideias.",
      };
    }
  },
});

export const generateKeywords = tool({
  description:
    "Pesquisa keywords de SEO a partir de uma ideia ou tema. Retorna volume de busca, CPC e dificuldade. Operação lenta (~30-90s).",
  inputSchema: z.object({
    idea: z.string().describe("Tema ou ideia para pesquisar keywords"),
    limit: z
      .number()
      .min(5)
      .max(50)
      .optional()
      .default(20)
      .describe("Número máximo de keywords (5-50)"),
    language: z
      .string()
      .optional()
      .default("pt")
      .describe("Idioma das keywords (ex: pt, en, es)"),
    locationCode: z
      .number()
      .optional()
      .default(2076)
      .describe("Código de localização (2076 = Brasil)"),
  }),
  execute: async ({ idea, limit, language, locationCode }) => {
    try {
      const { taskId } = await enqueueKeywordTask({
        idea,
        limit,
        language,
        locationCode,
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
          error instanceof Error ? error.message : "Erro ao pesquisar keywords.",
      };
    }
  },
});

export const getKeywordHistory = tool({
  description:
    "Busca o histórico de keywords já pesquisadas anteriormente. Operação rápida.",
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
            : "Erro ao buscar histórico de keywords.",
      };
    }
  },
});

export const generateTitles = tool({
  description:
    "Gera sugestões de títulos de artigos a partir de keywords. Envie uma lista de keywords.",
  inputSchema: z.object({
    keywords: z
      .array(
        z.object({
          keyword: z.string().describe("A keyword principal"),
          instruction: z
            .string()
            .optional()
            .describe("Instrução adicional para esta keyword"),
        }),
      )
      .min(1)
      .describe("Lista de keywords para gerar títulos"),
  }),
  execute: async ({ keywords }) => {
    try {
      const { titles } = await fetchTitlesFromCopilot({ keywords });
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
          error instanceof Error ? error.message : "Erro ao gerar títulos.",
      };
    }
  },
});

export const generateArticle = tool({
  description:
    "Gera um artigo completo de blog a partir de um título e keyword principal. Operação lenta (~1-3 min).",
  inputSchema: z.object({
    title: z.string().describe("Título do artigo"),
    keyword: z.string().describe("Keyword principal do artigo"),
    useResearch: z
      .boolean()
      .optional()
      .default(true)
      .describe("Se deve usar pesquisa web para enriquecer o artigo"),
    researchInstructions: z
      .string()
      .optional()
      .describe("Instruções para a pesquisa"),
    customInstructions: z
      .string()
      .optional()
      .describe("Instruções customizadas para o artigo"),
  }),
  execute: async ({
    title,
    keyword,
    useResearch,
    researchInstructions,
    customInstructions,
  }) => {
    try {
      const { taskId } = await enqueueArticleTask({
        title,
        keyword,
        useResearch,
        researchInstructions,
        customInstructions,
      });
      const result = await pollUntilReady(() =>
        fetchArticleTaskResult(taskId),
      );
      if (!result.ready || !result.articles?.length) {
        return {
          success: false as const,
          message: "Timeout ou nenhum artigo gerado. Tente novamente.",
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
          error instanceof Error ? error.message : "Erro ao gerar artigo.",
      };
    }
  },
});

export const generateSocialPosts = tool({
  description:
    "Gera posts para redes sociais (LinkedIn, Twitter/X, Instagram) a partir de um conteúdo base.",
  inputSchema: z.object({
    baseContent: z
      .string()
      .describe("Conteúdo base para gerar os posts (ex: texto de um artigo)"),
    instructions: z
      .string()
      .optional()
      .describe("Instruções adicionais de estilo ou foco"),
    language: z
      .string()
      .optional()
      .default("pt-BR")
      .describe("Idioma dos posts"),
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
            .describe("Número de variações por plataforma"),
        }),
      )
      .optional()
      .default([
        { platform: "linkedin", numVariations: 2 },
        { platform: "twitter", numVariations: 2 },
      ])
      .describe("Plataformas alvo e número de variações"),
  }),
  execute: async ({ baseContent, instructions, language, tone, platforms }) => {
    try {
      const posts = await generateSocialContent({
        baseContent,
        instructions,
        language,
        tone,
        platformConfigs: platforms.map((p) => ({
          platform: p.platform,
          numVariations: p.numVariations,
        })),
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
            : "Erro ao gerar social posts.",
      };
    }
  },
});

export const fetchBlogFeed = tool({
  description:
    "Busca os posts mais recentes publicados no blog da Kodus (WordPress). Retorna título, link, excerpt e data.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const endpoint = new URL(`${WORDPRESS_API_BASE}/posts`);
      endpoint.searchParams.set("per_page", "20");
      endpoint.searchParams.set("orderby", "date");
      endpoint.searchParams.set("order", "desc");
      endpoint.searchParams.set(
        "_fields",
        "id,title.rendered,link,date,excerpt.rendered",
      );

      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (!response.ok) {
        return {
          success: false as const,
          message: `Erro ao buscar feed (${response.status}).`,
        };
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        return { success: true as const, posts: [] as { id: string; title: string; link: string; excerpt: string; publishedAt: string | undefined }[] };
      }

      const posts = data
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
          const excerptObj = item.excerpt as
            | Record<string, unknown>
            | undefined;
          const excerpt =
            typeof excerptObj?.rendered === "string"
              ? excerptObj.rendered.replace(/<[^>]*>/g, "").trim().slice(0, 260)
              : "";

          if (!title || !link) return null;
          return {
            id: String(item.id),
            title,
            link,
            excerpt,
            publishedAt: date,
          };
        })
        .filter(Boolean);

      return { success: true as const, posts };
    } catch (error) {
      return {
        success: false as const,
        message:
          error instanceof Error ? error.message : "Erro ao buscar blog feed.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Content Plan (cross-data synthesis)
// ---------------------------------------------------------------------------

export const generateContentPlan = tool({
  description:
    "Gera um plano estratégico de conteúdo cruzando 5 fontes de dados: comunidade (Exa), oportunidades de SEO (Search Console), content decay (Analytics), blog posts existentes e histórico de keywords. Retorna 5-8 ideias ranqueadas com justificativa baseada em dados. (~10-15s)",
  inputSchema: z.object({
    topic: z
      .string()
      .optional()
      .describe(
        "Foco do plano de conteúdo. Se omitido, usa dados globais sem filtro de tema.",
      ),
    daysBack: z
      .number()
      .min(7)
      .max(365)
      .optional()
      .default(90)
      .describe("Período em dias para buscar discussões na comunidade (7-365, default 90)"),
    analyticsDays: z
      .number()
      .min(7)
      .max(90)
      .optional()
      .default(28)
      .describe("Período em dias para dados de analytics (7-90, default 28)"),
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
        contextParts.push(`## Foco do plano: "${topic}"\n`);
      }

      if (community.length > 0) {
        contextParts.push("## Discussões na comunidade");
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
          contextParts.push("### CTR Baixo (muitas impressões, CTR < 2%)");
          opportunities.lowCtr.slice(0, 8).forEach((r) => {
            contextParts.push(
              `- query="${r.query}" impr=${r.impressions} ctr=${(r.ctr * 100).toFixed(1)}% pos=${r.position.toFixed(1)} page=${r.page}`,
            );
          });
        }
        if (opportunities.strikingDistance.length > 0) {
          contextParts.push("### Striking Distance (posição 5-20)");
          opportunities.strikingDistance.slice(0, 8).forEach((r) => {
            contextParts.push(
              `- query="${r.query}" impr=${r.impressions} pos=${r.position.toFixed(1)} page=${r.page}`,
            );
          });
        }
        contextParts.push("");
      }

      if (decay.length > 0) {
        contextParts.push("## Páginas perdendo tráfego (Content Decay)");
        decay.slice(0, 8).forEach((r) => {
          contextParts.push(
            `- ${r.page} — de ${r.previousPageviews} para ${r.currentPageviews} pageviews (${r.changePercent.toFixed(0)}%)`,
          );
        });
        contextParts.push("");
      }

      if (blogPosts.length > 0) {
        contextParts.push("## Posts já publicados no blog");
        blogPosts.slice(0, 15).forEach((p) => {
          contextParts.push(
            `- "${p.title}" (${p.publishedAt?.slice(0, 10) ?? "sem data"})`,
          );
        });
        contextParts.push("");
      }

      if (keywords.length > 0) {
        contextParts.push("## Keywords já pesquisadas");
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
        prompt: contextString || "Não há dados disponíveis. Gere ideias gerais para um blog de tecnologia focado em DevOps, CI/CD, Code Review e AI.",
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
          message: "Erro ao interpretar resposta da AI. Tente novamente.",
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
            : "Erro ao gerar plano de conteúdo.",
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
    .describe("Data inicial (YYYY-MM-DD). Default: últimos 28 dias."),
  endDate: z
    .string()
    .optional()
    .describe("Data final (YYYY-MM-DD). Default: hoje."),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe("Número máximo de resultados (1-50, default 20)"),
};

export const getSearchPerformance = tool({
  description:
    "Busca métricas de performance de busca orgânica do Google Search Console (clicks, impressões, CTR, posição). Retorna totais + top queries + top pages.",
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
            : "Erro ao buscar dados do Search Console.",
      };
    }
  },
});

export const getTrafficOverview = tool({
  description:
    "Busca visão geral de tráfego do Google Analytics: usuários, sessões, pageviews, fontes de tráfego e tendência diária.",
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
            : "Erro ao buscar dados de tráfego.",
      };
    }
  },
});

export const getTopContent = tool({
  description:
    "Busca as páginas com mais tráfego no Google Analytics: pageviews e bounce rate. Aceita filtro de path (ex: /blog).",
  inputSchema: z.object({
    ...dateSchema,
    pathFilter: z
      .string()
      .optional()
      .describe("Filtro de path (ex: /blog). Retorna pages que começam com esse prefixo."),
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
            : "Erro ao buscar top content.",
      };
    }
  },
});

export const getContentOpportunities = tool({
  description:
    "Identifica oportunidades de conteúdo: queries com muitas impressões mas CTR baixo (<2%), e queries em striking distance (posição 5-20 no Google).",
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
            : "Erro ao buscar oportunidades.",
      };
    }
  },
});

export const comparePerformance = tool({
  description:
    "Compara métricas de busca orgânica (Search Console) e tráfego (GA) entre o período atual e o anterior de mesmo tamanho. Retorna totais + % de variação.",
  inputSchema: z.object({
    startDate: z
      .string()
      .optional()
      .describe("Data inicial (YYYY-MM-DD). Default: últimos 28 dias."),
    endDate: z
      .string()
      .optional()
      .describe("Data final (YYYY-MM-DD). Default: hoje."),
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
            : "Erro ao comparar períodos.",
      };
    }
  },
});

export const getContentDecay = tool({
  description:
    "Identifica páginas que estão perdendo tráfego comparando o período atual com o anterior. Retorna lista de páginas com queda de pageviews, ordenada por maior queda.",
  inputSchema: z.object({
    startDate: z
      .string()
      .optional()
      .describe("Data inicial (YYYY-MM-DD). Default: últimos 28 dias."),
    endDate: z
      .string()
      .optional()
      .describe("Data final (YYYY-MM-DD). Default: hoje."),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(30)
      .describe("Número máximo de páginas (1-50, default 30)"),
    minPageviews: z
      .number()
      .optional()
      .default(10)
      .describe("Mínimo de pageviews no período anterior para considerar (default 10)"),
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
            : "Erro ao buscar content decay.",
      };
    }
  },
});

export const getSearchBySegment = tool({
  description:
    "Analisa métricas de busca orgânica segmentadas por device (DESKTOP, MOBILE, TABLET) ou país. Retorna clicks, impressões, CTR e posição por segmento.",
  inputSchema: z.object({
    startDate: z
      .string()
      .optional()
      .describe("Data inicial (YYYY-MM-DD). Default: últimos 28 dias."),
    endDate: z
      .string()
      .optional()
      .describe("Data final (YYYY-MM-DD). Default: hoje."),
    segment: z
      .enum(["device", "country"])
      .describe("Segmento para agrupar: 'device' ou 'country'"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe("Número máximo de segmentos (1-50, default 20)"),
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
            : "Erro ao buscar dados por segmento.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Page Keywords (keyword-to-page mapping)
// ---------------------------------------------------------------------------

export const getPageKeywords = tool({
  description:
    "Mostra quais keywords do Google trazem tráfego para uma página específica. Aceita URL completa ou path parcial (ex: /blog/code-review). Retorna clicks, impressões, CTR e posição de cada keyword.",
  inputSchema: z.object({
    page: z
      .string()
      .describe("URL ou path da página (ex: /blog/code-review ou kodus.io/blog/code-review)"),
    startDate: z
      .string()
      .optional()
      .describe("Data inicial (YYYY-MM-DD). Default: últimos 28 dias."),
    endDate: z
      .string()
      .optional()
      .describe("Data final (YYYY-MM-DD). Default: hoje."),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(30)
      .describe("Número máximo de keywords (1-50, default 30)"),
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
            : "Erro ao buscar keywords da página.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Competitor Analysis
// ---------------------------------------------------------------------------

export const analyzeCompetitor = tool({
  description:
    "Analisa conteúdo de concorrentes sobre um tema usando busca na web. Retorna os melhores artigos encontrados com resumo, highlights e fonte. Útil para entender o que os concorrentes estão cobrindo e como se diferenciar.",
  inputSchema: z.object({
    topic: z
      .string()
      .describe("Tema para pesquisar conteúdo concorrente (ex: 'code review best practices')"),
    targetDomains: z
      .array(z.string())
      .optional()
      .describe("Domínios específicos de concorrentes para focar (ex: ['linearb.io', 'atlassian.com'])"),
    numResults: z
      .number()
      .min(3)
      .max(20)
      .optional()
      .default(10)
      .describe("Número de resultados (3-20, default 10)"),
    daysBack: z
      .number()
      .min(30)
      .max(365)
      .optional()
      .default(180)
      .describe("Período em dias para buscar (30-365, default 180)"),
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
            : "Erro ao analisar concorrentes.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Scheduled Jobs Tools
// ---------------------------------------------------------------------------

export const scheduleJob = tool({
  description:
    "Cria uma tarefa agendada (scheduled job) que executa um prompt automaticamente de forma recorrente e envia o resultado via webhook.",
  inputSchema: z.object({
    user_email: z.string().describe("Email do usuário que está criando o job"),
    name: z.string().describe("Nome descritivo do job (ex: 'Relatório SEO Semanal')"),
    prompt: z.string().describe("O prompt que será executado automaticamente a cada execução"),
    schedule: z
      .enum(["daily_9am", "weekly_monday", "weekly_friday", "biweekly", "monthly_first"])
      .describe("Frequência do agendamento"),
    webhook_url: z.string().url().describe("URL do webhook que receberá o resultado via POST"),
  }),
  execute: async ({ user_email, name, prompt, schedule, webhook_url }) => {
    try {
      const client = getSupabaseServiceClient();
      const preset = SCHEDULE_PRESETS[schedule as SchedulePreset];
      const job = await createJob(client, {
        user_email,
        name,
        prompt,
        cron_expression: preset.cron,
        webhook_url,
      });
      return {
        success: true as const,
        job: {
          id: job.id,
          name: job.name,
          schedule: preset.label,
          cron: preset.cron,
          webhook_url: job.webhook_url,
          enabled: job.enabled,
        },
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Erro ao criar job agendado.",
      };
    }
  },
});

export const listScheduledJobs = tool({
  description: "Lista todas as tarefas agendadas (scheduled jobs) do usuário.",
  inputSchema: z.object({
    user_email: z.string().describe("Email do usuário"),
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
          schedule_label:
            Object.values(SCHEDULE_PRESETS).find((p) => p.cron === j.cron_expression)?.label ??
            j.cron_expression,
          webhook_url: j.webhook_url,
          enabled: j.enabled,
          last_run_at: j.last_run_at,
        })),
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Erro ao listar jobs.",
      };
    }
  },
});

export const deleteScheduledJob = tool({
  description: "Remove uma tarefa agendada (scheduled job) do usuário.",
  inputSchema: z.object({
    user_email: z.string().describe("Email do usuário"),
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
        message: error instanceof Error ? error.message : "Erro ao deletar job.",
      };
    }
  },
});

export const scheduleArticlePublication = tool({
  description:
    "Agenda a publicação automática de um artigo. Cria um job agendado que gera o artigo a partir de título e keyword e publica automaticamente. Não precisa de webhook — o artigo é publicado direto no WordPress.",
  inputSchema: z.object({
    user_email: z.string().describe("Email do usuário que está criando o agendamento"),
    title: z.string().describe("Título do artigo a ser gerado"),
    keyword: z.string().describe("Keyword principal do artigo"),
    schedule: z
      .enum(["daily_9am", "weekly_monday", "weekly_friday", "biweekly", "monthly_first"])
      .describe("Quando publicar o artigo"),
    useResearch: z
      .boolean()
      .optional()
      .default(true)
      .describe("Se deve usar pesquisa web para enriquecer o artigo"),
    customInstructions: z
      .string()
      .optional()
      .describe("Instruções customizadas para o artigo"),
  }),
  execute: async ({ user_email, title, keyword, schedule, useResearch, customInstructions }) => {
    try {
      const client = getSupabaseServiceClient();
      const preset = SCHEDULE_PRESETS[schedule as SchedulePreset];

      // Build a self-contained prompt that the job executor will run
      const articlePrompt = [
        `Gere e publique um artigo com o título "${title}" e keyword principal "${keyword}".`,
        useResearch ? "Use pesquisa web para enriquecer o conteúdo." : "",
        customInstructions ? `Instruções adicionais: ${customInstructions}` : "",
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
        cron_expression: preset.cron,
        webhook_url: `${appUrl}/api/canvas/explore`,
      });

      return {
        success: true as const,
        job: {
          id: job.id,
          name: job.name,
          title,
          keyword,
          schedule: preset.label,
          cron: preset.cron,
          enabled: job.enabled,
        },
        message: `Artigo "${title}" agendado para ${preset.label}. O artigo será gerado e publicado automaticamente.`,
      };
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "Erro ao agendar publicação.",
      };
    }
  },
});

export const agentTools = {
  generateIdeas,
  generateContentPlan,
  generateKeywords,
  getKeywordHistory,
  generateTitles,
  generateArticle,
  generateSocialPosts,
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
