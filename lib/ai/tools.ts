import { tool } from "ai";
import { z } from "zod";
import {
  enqueueKeywordTask,
  fetchKeywordTaskResult,
  fetchKeywordsHistory,
  fetchTitlesFromCopilot,
  enqueueArticleTask,
  fetchArticleTaskResult,
  generateSocialContent,
} from "@/lib/copilot";
import { searchIdeas } from "@/lib/exa";
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
} from "@/lib/bigquery";

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
    "Pesquisa discussoes reais em Reddit, dev.to, HackerNews, StackOverflow e Twitter/X para descobrir ideias de conteudo baseadas em dores, perguntas e tendencias da audiencia. (~3-5s)",
  inputSchema: z.object({
    topic: z.string().describe("Tema ou nicho para pesquisar ideias"),
    sources: z
      .array(z.string())
      .optional()
      .describe(
        "Dominios para buscar (default: reddit.com, dev.to, news.ycombinator.com, stackoverflow.com, x.com)",
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
        "id,title.rendered,link,date,content.rendered,excerpt.rendered",
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

export const agentTools = {
  generateIdeas,
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
  scheduleJob,
  listScheduledJobs,
  deleteScheduledJob,
};
