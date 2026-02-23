"use client";

import { Loader2, Search, FileText, Newspaper, Share2, Rss, History, Lightbulb, BarChart3, Globe, TrendingUp, Target, GitCompare, TrendingDown, Smartphone, Calendar, List, Trash2, LayoutList, Link2, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type ToolInvocationState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

type ToolResultProps = {
  toolName: string;
  state: ToolInvocationState;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
};

const TOOL_META: Record<string, { label: string; loadingMsg: string; icon: React.ElementType }> = {
  generateIdeas: { label: "Pesquisa de Ideias", loadingMsg: "Pesquisando discussoes...", icon: Lightbulb },
  generateContentPlan: { label: "Plano de Conteúdo", loadingMsg: "Cruzando dados e gerando plano estratégico...", icon: LayoutList },
  generateKeywords: { label: "Pesquisa de Keywords", loadingMsg: "Pesquisando keywords... isso pode levar ~30-90s", icon: Search },
  getKeywordHistory: { label: "Histórico de Keywords", loadingMsg: "Buscando histórico...", icon: History },
  generateTitles: { label: "Geração de Títulos", loadingMsg: "Gerando sugestões de títulos...", icon: FileText },
  generateArticle: { label: "Geração de Artigo", loadingMsg: "Gerando artigo completo... isso pode levar ~1-3 min", icon: Newspaper },
  generateSocialPosts: { label: "Social Posts", loadingMsg: "Gerando posts para redes sociais...", icon: Share2 },
  fetchBlogFeed: { label: "Blog Feed", loadingMsg: "Buscando posts do blog...", icon: Rss },
  getSearchPerformance: { label: "Search Performance", loadingMsg: "Buscando dados do Search Console...", icon: BarChart3 },
  getTrafficOverview: { label: "Traffic Overview", loadingMsg: "Buscando dados de tráfego...", icon: Globe },
  getTopContent: { label: "Top Content", loadingMsg: "Buscando top páginas...", icon: TrendingUp },
  getContentOpportunities: { label: "Content Opportunities", loadingMsg: "Analisando oportunidades...", icon: Target },
  comparePerformance: { label: "Comparação de Períodos", loadingMsg: "Comparando períodos...", icon: GitCompare },
  getContentDecay: { label: "Content Decay", loadingMsg: "Analisando content decay...", icon: TrendingDown },
  getSearchBySegment: { label: "Análise por Segmento", loadingMsg: "Analisando segmentos...", icon: Smartphone },
  getPageKeywords: { label: "Keywords da Página", loadingMsg: "Buscando keywords que trazem tráfego...", icon: Link2 },
  analyzeCompetitor: { label: "Análise de Concorrentes", loadingMsg: "Analisando conteúdo concorrente...", icon: Eye },
  scheduleJob: { label: "Agendar Tarefa", loadingMsg: "Criando job agendado...", icon: Calendar },
  listScheduledJobs: { label: "Jobs Agendados", loadingMsg: "Buscando jobs agendados...", icon: List },
  deleteScheduledJob: { label: "Remover Job", loadingMsg: "Removendo job...", icon: Trash2 },
};

function difficultyColor(score: number): string {
  if (score < 20) return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
  if (score < 40) return "bg-green-500/20 text-green-400 border-green-500/30";
  if (score < 60) return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  if (score < 80) return "bg-orange-500/20 text-orange-400 border-orange-500/30";
  return "bg-red-500/20 text-red-400 border-red-500/30";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type Keyword = {
  id?: string;
  phrase: string;
  volume: number;
  cpc: number;
  difficulty: number;
  difficultyLabel?: string | null;
  idea?: string | null;
};

function KeywordsTable({ keywords }: { keywords: Keyword[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.06] text-left">
            <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Keyword</th>
            <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Volume</th>
            <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">CPC</th>
            <th className="pb-2 text-center text-xs font-medium text-neutral-400">Dificuldade</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr key={kw.id ?? i} className="border-b border-white/[0.04] last:border-0">
              <td className="py-2 pr-4 font-medium text-neutral-200">{kw.phrase}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-neutral-400">
                {kw.volume.toLocaleString("pt-BR")}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-neutral-400">
                ${kw.cpc.toFixed(2)}
              </td>
              <td className="py-2 text-center">
                <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${difficultyColor(kw.difficulty)}`}>
                  {kw.difficultyLabel || kw.difficulty}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type TitleItem = { id?: string; text: string; keywords?: string[]; mood?: string };

function TitlesList({ titles }: { titles: TitleItem[] }) {
  return (
    <div className="space-y-2">
      {titles.map((t, i) => (
        <div key={t.id ?? i} className="flex items-start gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-medium text-neutral-400">
            {i + 1}
          </span>
          <div>
            <p className="text-sm font-medium text-neutral-200">{t.text}</p>
            {t.keywords && t.keywords.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {t.keywords.map((kw) => (
                  <Badge key={kw} variant="outline" className="border-white/10 text-[10px] text-neutral-500">
                    {kw}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

type ArticlePreview = { title?: string; keyword?: string; content?: string; url?: string; status?: string };

function ArticlePreviewCard({ article }: { article: ArticlePreview }) {
  return (
    <div className="space-y-2">
      {article.title && (
        <h4 className="text-sm font-semibold text-neutral-200">{article.title}</h4>
      )}
      <div className="flex flex-wrap gap-1.5">
        {article.keyword && (
          <Badge variant="outline" className="border-white/10 text-[10px] text-neutral-400">{article.keyword}</Badge>
        )}
        {article.status && (
          <Badge className="border-0 bg-white/10 text-[10px] text-neutral-400">{article.status}</Badge>
        )}
      </div>
      {article.url && (
        <a href={article.url} target="_blank" rel="noopener noreferrer" className="block text-xs text-violet-400 hover:underline break-all">
          {article.url}
        </a>
      )}
      {article.content && (
        <p className="text-xs leading-relaxed text-neutral-400 line-clamp-6">
          {article.content.slice(0, 800)}
        </p>
      )}
    </div>
  );
}

type SocialPost = { variant: number; hook: string; post: string; cta: string; hashtags: string[]; platform?: string };

function SocialPostsView({ posts }: { posts: SocialPost[] }) {
  const grouped = posts.reduce<Record<string, SocialPost[]>>((acc, post) => {
    const key = post.platform || "geral";
    if (!acc[key]) acc[key] = [];
    acc[key].push(post);
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([platform, items]) => (
        <div key={platform}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {platform}
          </p>
          <div className="space-y-2">
            {items.map((post, i) => (
              <div key={i} className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-3 text-sm">
                {post.hook && (
                  <p className="mb-1 font-semibold text-neutral-200">{post.hook}</p>
                )}
                <p className="whitespace-pre-wrap text-neutral-400">{post.post}</p>
                {post.cta && (
                  <p className="mt-1.5 text-xs font-medium text-violet-400">{post.cta}</p>
                )}
                {post.hashtags.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-neutral-600">
                    {post.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join("  ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type FeedPost = { id: string; title: string; link: string; excerpt?: string; publishedAt?: string };

function BlogFeedList({ posts }: { posts: FeedPost[] }) {
  return (
    <div className="space-y-1.5">
      {posts.map((post) => (
        <div key={post.id} className="flex items-baseline gap-2 text-sm">
          {post.publishedAt && (
            <span className="shrink-0 text-xs tabular-nums text-neutral-500">
              {new Date(post.publishedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
            </span>
          )}
          <a href={post.link} target="_blank" rel="noopener noreferrer" className="font-medium text-neutral-300 hover:text-violet-400 hover:underline">
            {post.title}
          </a>
        </div>
      ))}
    </div>
  );
}

type IdeaAngle = "pain_points" | "questions" | "trends";

type IdeaResult = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedDate: string | null;
  summary: string | null;
  highlights: string[];
  angle: IdeaAngle;
  angleLabel: string;
};

const ANGLE_COLORS: Record<IdeaAngle, string> = {
  pain_points: "bg-red-500/20 text-red-400 border-red-500/30",
  questions: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  trends: "bg-green-500/20 text-green-400 border-green-500/30",
};

const SOURCE_COLORS: Record<string, string> = {
  Reddit: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  "dev.to": "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
  HackerNews: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  StackOverflow: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  Twitter: "bg-sky-500/20 text-sky-400 border-sky-500/30",
};

function IdeaResultsView({ results }: { results: IdeaResult[] }) {
  const grouped = results.reduce<Record<IdeaAngle, IdeaResult[]>>(
    (acc, r) => {
      if (!acc[r.angle]) acc[r.angle] = [];
      acc[r.angle].push(r);
      return acc;
    },
    {} as Record<IdeaAngle, IdeaResult[]>,
  );

  const angleOrder: IdeaAngle[] = ["pain_points", "questions", "trends"];

  return (
    <div className="space-y-4">
      {angleOrder.map((angle) => {
        const items = grouped[angle];
        if (!items?.length) return null;
        const label = items[0].angleLabel;
        return (
          <div key={angle}>
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${ANGLE_COLORS[angle]}`}
              >
                {label}
              </span>
              <span className="text-[10px] text-neutral-500">
                {items.length} resultado{items.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="space-y-2">
              {items.map((r) => (
                <div
                  key={r.id}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-3"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 inline-block shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${SOURCE_COLORS[r.source] ?? "bg-white/10 text-neutral-400 border-white/10"}`}
                    >
                      {r.source}
                    </span>
                    <div className="min-w-0 flex-1">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-neutral-200 hover:text-violet-400 hover:underline"
                      >
                        {r.title}
                      </a>
                      {r.publishedDate && (
                        <span className="ml-2 text-[10px] text-neutral-500">
                          {new Date(r.publishedDate).toLocaleDateString(
                            "pt-BR",
                            { day: "2-digit", month: "short", year: "numeric" },
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                  {r.summary && (
                    <p className="mt-1.5 text-xs leading-relaxed text-neutral-400 line-clamp-3">
                      {r.summary}
                    </p>
                  )}
                  {r.highlights.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {r.highlights.slice(0, 2).map((h, i) => (
                        <blockquote
                          key={i}
                          className="border-l-2 border-violet-500/30 pl-2 text-[11px] italic text-neutral-500 line-clamp-2"
                        >
                          {h}
                        </blockquote>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content Plan sub-components
// ---------------------------------------------------------------------------

type ContentPlanIdea = {
  rank: number;
  title: string;
  type: "new" | "refresh" | "optimize";
  priority: "high" | "medium" | "low";
  description: string;
  rationale: string;
  dataSignals: string[];
  suggestedKeywords: string[];
  estimatedDifficulty: "easy" | "medium" | "hard";
  existingPage: string | null;
  nextSteps: string[];
};

type ContentPlanData = {
  summary: string;
  ideas: ContentPlanIdea[];
  dataCounts: {
    community: number;
    opportunities: number;
    decaying: number;
    blogPosts: number;
    keywords: number;
  };
};

const TYPE_BADGE: Record<string, string> = {
  new: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  refresh: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  optimize: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

const TYPE_LABEL: Record<string, string> = {
  new: "Novo",
  refresh: "Atualizar",
  optimize: "Otimizar",
};

const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-red-500/20 text-red-400 border-red-500/30",
  medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  low: "bg-neutral-500/20 text-neutral-400 border-neutral-500/30",
};

const PRIORITY_LABEL: Record<string, string> = {
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "Fácil",
  medium: "Média",
  hard: "Difícil",
};

function ContentPlanView({ data }: { data: ContentPlanData }) {
  const counts = data.dataCounts;

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="rounded-lg border border-violet-500/30 bg-violet-500/[0.08] p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-violet-400 mb-1">
          Resumo Executivo
        </p>
        <p className="text-sm leading-relaxed text-neutral-300">{data.summary}</p>
      </div>

      {/* Sources bar */}
      <div className="flex flex-wrap gap-2">
        {counts.community > 0 && (
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-neutral-400">
            {counts.community} discussões
          </span>
        )}
        {counts.opportunities > 0 && (
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-neutral-400">
            {counts.opportunities} oportunidades SEO
          </span>
        )}
        {counts.decaying > 0 && (
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-neutral-400">
            {counts.decaying} páginas em queda
          </span>
        )}
        {counts.blogPosts > 0 && (
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-neutral-400">
            {counts.blogPosts} posts publicados
          </span>
        )}
        {counts.keywords > 0 && (
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-neutral-400">
            {counts.keywords} keywords
          </span>
        )}
      </div>

      {/* Ideas list */}
      <div className="space-y-3">
        {data.ideas.map((idea, i) => (
          <div
            key={i}
            className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-3 space-y-2.5"
          >
            {/* Header: rank + title + badges */}
            <div className="flex items-start gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-xs font-bold text-violet-400">
                {idea.rank}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-neutral-200">
                  {idea.title}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span
                    className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_BADGE[idea.type] ?? TYPE_BADGE.new}`}
                  >
                    {TYPE_LABEL[idea.type] ?? idea.type}
                  </span>
                  <span
                    className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${PRIORITY_BADGE[idea.priority] ?? PRIORITY_BADGE.medium}`}
                  >
                    Prioridade {PRIORITY_LABEL[idea.priority] ?? idea.priority}
                  </span>
                  <span className="inline-block rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-neutral-500">
                    {DIFFICULTY_LABEL[idea.estimatedDifficulty] ?? idea.estimatedDifficulty}
                  </span>
                </div>
              </div>
            </div>

            {/* Description */}
            <p className="text-xs leading-relaxed text-neutral-400 pl-8">
              {idea.description}
            </p>

            {/* Rationale card */}
            <div className="ml-8 rounded-md border border-violet-500/20 bg-violet-500/[0.05] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-400/70 mb-0.5">
                Por que criar
              </p>
              <p className="text-xs leading-relaxed text-neutral-400">
                {idea.rationale}
              </p>
            </div>

            {/* Data signals */}
            {idea.dataSignals?.length > 0 && (
              <div className="ml-8 flex flex-wrap gap-1">
                {idea.dataSignals.map((signal, si) => (
                  <span
                    key={si}
                    className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[10px] text-neutral-500"
                  >
                    {signal}
                  </span>
                ))}
              </div>
            )}

            {/* Keywords */}
            {idea.suggestedKeywords?.length > 0 && (
              <div className="ml-8 flex flex-wrap gap-1">
                {idea.suggestedKeywords.map((kw) => (
                  <Badge
                    key={kw}
                    variant="outline"
                    className="border-violet-500/20 text-[10px] text-violet-400/70"
                  >
                    {kw}
                  </Badge>
                ))}
              </div>
            )}

            {/* Existing page */}
            {idea.existingPage && (
              <p className="ml-8 text-[11px] text-neutral-500">
                Página existente:{" "}
                <span className="font-mono text-neutral-400">
                  {idea.existingPage}
                </span>
              </p>
            )}

            {/* Next steps */}
            {idea.nextSteps?.length > 0 && (
              <div className="ml-8">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-1">
                  Próximos passos
                </p>
                <ul className="space-y-0.5">
                  {idea.nextSteps.map((step, si) => (
                    <li key={si} className="flex items-start gap-1.5 text-[11px] text-neutral-400">
                      <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-neutral-600" />
                      {step}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analytics sub-components
// ---------------------------------------------------------------------------

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-neutral-200">{value}</p>
      {sub && <p className="text-[10px] text-neutral-500">{sub}</p>}
    </div>
  );
}

function formatNum(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatPos(n: number): string {
  return n.toFixed(1);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function truncatePage(url: string, max = 50): string {
  try {
    const u = new URL(url);
    const path = u.pathname;
    return path.length > max ? `...${path.slice(-max)}` : path;
  } catch {
    return url.length > max ? `...${url.slice(-max)}` : url;
  }
}

type SearchPerfData = {
  totals: { clicks: number; impressions: number; avgCtr: number; avgPosition: number };
  topQueries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  topPages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
};

function SearchPerformanceView({ data }: { data: SearchPerfData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        <KpiCard label="Cliques" value={formatNum(data.totals.clicks)} />
        <KpiCard label="Impressões" value={formatNum(data.totals.impressions)} />
        <KpiCard label="CTR Médio" value={formatPct(data.totals.avgCtr)} />
        <KpiCard label="Posição Média" value={formatPos(data.totals.avgPosition)} />
      </div>

      {data.topQueries.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-neutral-400">Top Queries</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-left">
                  <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Query</th>
                  <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Clicks</th>
                  <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Impr.</th>
                  <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">CTR</th>
                  <th className="pb-2 text-right text-xs font-medium text-neutral-400">Pos.</th>
                </tr>
              </thead>
              <tbody>
                {data.topQueries.map((q, i) => (
                  <tr key={i} className="border-b border-white/[0.04] last:border-0">
                    <td className="py-1.5 pr-4 font-medium text-neutral-200">{q.query}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(q.clicks)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(q.impressions)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatPct(q.ctr)}</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-400">{formatPos(q.position)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.topPages.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-neutral-400">Top Pages</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-left">
                  <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Page</th>
                  <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Clicks</th>
                  <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Impr.</th>
                  <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">CTR</th>
                  <th className="pb-2 text-right text-xs font-medium text-neutral-400">Pos.</th>
                </tr>
              </thead>
              <tbody>
                {data.topPages.map((p, i) => (
                  <tr key={i} className="border-b border-white/[0.04] last:border-0">
                    <td className="py-1.5 pr-4 font-mono text-xs text-neutral-300" title={p.page}>{truncatePage(p.page)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(p.clicks)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(p.impressions)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatPct(p.ctr)}</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-400">{formatPos(p.position)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

type TrafficData = {
  overview: { users: number; sessions: number; pageviews: number };
  topSources: { source: string; medium: string; users: number }[];
  dailyTrend: { date: string; users: number }[];
};

function TrafficOverviewView({ data }: { data: TrafficData }) {
  const maxUsers = Math.max(...data.dailyTrend.map((d) => d.users), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <KpiCard label="Usuários" value={formatNum(data.overview.users)} />
        <KpiCard label="Sessões" value={formatNum(data.overview.sessions)} />
        <KpiCard label="Pageviews" value={formatNum(data.overview.pageviews)} />
      </div>

      {data.topSources.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-neutral-400">Fontes de Tráfego</p>
          <div className="space-y-1">
            {data.topSources.map((s, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-neutral-300">
                  {s.source}{s.medium ? ` / ${s.medium}` : ""}
                </span>
                <span className="tabular-nums text-neutral-400">{formatNum(s.users)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.dailyTrend.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-neutral-400">Tendência Diária</p>
          <div className="flex items-end gap-px" style={{ height: 48 }}>
            {data.dailyTrend.map((d, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm bg-violet-500/40"
                style={{ height: `${Math.max((d.users / maxUsers) * 100, 4)}%` }}
                title={`${d.date}: ${formatNum(d.users)} users`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type TopContentData = {
  pages: { page: string; pageviews: number; bounceRate: number }[];
};

function TopContentView({ data }: { data: TopContentData }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.06] text-left">
            <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Página</th>
            <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Pageviews</th>
            <th className="pb-2 text-right text-xs font-medium text-neutral-400">Bounce Rate</th>
          </tr>
        </thead>
        <tbody>
          {data.pages.map((p, i) => (
            <tr key={i} className="border-b border-white/[0.04] last:border-0">
              <td className="py-1.5 pr-4 font-mono text-xs text-neutral-300" title={p.page}>{truncatePage(p.page)}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(p.pageviews)}</td>
              <td className="py-1.5 text-right tabular-nums text-neutral-400">{formatPct(p.bounceRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type OpportunitiesData = {
  lowCtr: { query: string; page: string; impressions: number; ctr: number; position: number }[];
  strikingDistance: { query: string; page: string; impressions: number; ctr: number; position: number }[];
};

function OpportunityTable({
  rows,
}: {
  rows: { query: string; page: string; impressions: number; ctr: number; position: number }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.06] text-left">
            <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Query</th>
            <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Page</th>
            <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Impr.</th>
            <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">CTR</th>
            <th className="pb-2 text-right text-xs font-medium text-neutral-400">Pos.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-white/[0.04] last:border-0">
              <td className="py-1.5 pr-4 font-medium text-neutral-200">{r.query}</td>
              <td className="py-1.5 pr-4 font-mono text-xs text-neutral-400" title={r.page}>{truncatePage(r.page, 35)}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(r.impressions)}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatPct(r.ctr)}</td>
              <td className="py-1.5 text-right tabular-nums text-neutral-400">{formatPos(r.position)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContentOpportunitiesView({ data }: { data: OpportunitiesData }) {
  return (
    <div className="space-y-4">
      {data.lowCtr.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge className="border-amber-500/30 bg-amber-500/20 text-amber-400 hover:bg-amber-500/20">
              CTR Baixo
            </Badge>
            <span className="text-[10px] text-neutral-500">
              Muitas impressões, CTR &lt; 2%
            </span>
          </div>
          <OpportunityTable rows={data.lowCtr} />
        </div>
      )}

      {data.strikingDistance.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge className="border-emerald-500/30 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20">
              Striking Distance
            </Badge>
            <span className="text-[10px] text-neutral-500">
              Posição 5-20 — próximas do topo
            </span>
          </div>
          <OpportunityTable rows={data.strikingDistance} />
        </div>
      )}

      {data.lowCtr.length === 0 && data.strikingDistance.length === 0 && (
        <p className="text-xs text-neutral-500">Nenhuma oportunidade identificada no período.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare Performance
// ---------------------------------------------------------------------------

type CompareMetric = { current: number; previous: number; change: number };

function ChangeBadge({ value }: { value: number }) {
  const isPositive = value > 0;
  const color = isPositive
    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
    : "bg-red-500/20 text-red-400 border-red-500/30";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}>
      {isPositive ? "+" : ""}{value.toFixed(1)}%
    </span>
  );
}

function CompareRow({ label, current, previous, change, formatter }: {
  label: string;
  current: number;
  previous: number;
  change: number;
  formatter: (n: number) => string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
      <span className="text-sm text-neutral-300">{label}</span>
      <div className="flex items-center gap-3">
        <span className="text-sm tabular-nums text-neutral-200">{formatter(current)}</span>
        <span className="text-xs tabular-nums text-neutral-500">vs {formatter(previous)}</span>
        <ChangeBadge value={change} />
      </div>
    </div>
  );
}

type ComparePerformanceData = {
  search: {
    current: { clicks: number; impressions: number; avgCtr: number; avgPosition: number };
    previous: { clicks: number; impressions: number; avgCtr: number; avgPosition: number };
    change: { clicks: number; impressions: number; avgCtr: number; avgPosition: number };
  };
  traffic: {
    current: { users: number; sessions: number; pageviews: number };
    previous: { users: number; sessions: number; pageviews: number };
    change: { users: number; sessions: number; pageviews: number };
  };
  periodLabel: string;
};

function ComparePerformanceView({ data }: { data: ComparePerformanceData }) {
  return (
    <div className="space-y-4">
      <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{data.periodLabel}</p>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-neutral-400">Search Console</p>
        <div>
          <CompareRow label="Clicks" current={data.search.current.clicks} previous={data.search.previous.clicks} change={data.search.change.clicks} formatter={formatNum} />
          <CompareRow label="Impressões" current={data.search.current.impressions} previous={data.search.previous.impressions} change={data.search.change.impressions} formatter={formatNum} />
          <CompareRow label="CTR Médio" current={data.search.current.avgCtr} previous={data.search.previous.avgCtr} change={data.search.change.avgCtr} formatter={formatPct} />
          <CompareRow label="Posição Média" current={data.search.current.avgPosition} previous={data.search.previous.avgPosition} change={data.search.change.avgPosition} formatter={formatPos} />
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-neutral-400">Google Analytics</p>
        <div>
          <CompareRow label="Usuários" current={data.traffic.current.users} previous={data.traffic.previous.users} change={data.traffic.change.users} formatter={formatNum} />
          <CompareRow label="Sessões" current={data.traffic.current.sessions} previous={data.traffic.previous.sessions} change={data.traffic.change.sessions} formatter={formatNum} />
          <CompareRow label="Pageviews" current={data.traffic.current.pageviews} previous={data.traffic.previous.pageviews} change={data.traffic.change.pageviews} formatter={formatNum} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content Decay
// ---------------------------------------------------------------------------

type ContentDecayData = {
  decaying: { page: string; currentPageviews: number; previousPageviews: number; changePercent: number }[];
  periodLabel: string;
};

function ContentDecayView({ data }: { data: ContentDecayData }) {
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{data.periodLabel}</p>
      {data.decaying.length === 0 ? (
        <p className="text-xs text-neutral-500">Nenhuma página com queda significativa.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-left">
                <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Página</th>
                <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Atual</th>
                <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Anterior</th>
                <th className="pb-2 text-right text-xs font-medium text-neutral-400">Variação</th>
              </tr>
            </thead>
            <tbody>
              {data.decaying.map((p, i) => (
                <tr key={i} className="border-b border-white/[0.04] last:border-0">
                  <td className="py-1.5 pr-4 font-mono text-xs text-neutral-300" title={p.page}>{truncatePage(p.page)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(p.currentPageviews)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(p.previousPageviews)}</td>
                  <td className="py-1.5 text-right">
                    <span className="inline-block rounded-full border border-red-500/30 bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
                      {p.changePercent.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search by Segment
// ---------------------------------------------------------------------------

type SearchBySegmentData = {
  segments: { segment: string; clicks: number; impressions: number; ctr: number; position: number }[];
};

function SearchBySegmentView({ data }: { data: SearchBySegmentData }) {
  return (
    <div className="overflow-x-auto">
      {data.segments.length === 0 ? (
        <p className="text-xs text-neutral-500">Nenhum dado por segmento.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] text-left">
              <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Segmento</th>
              <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Clicks</th>
              <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Impr.</th>
              <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">CTR</th>
              <th className="pb-2 text-right text-xs font-medium text-neutral-400">Pos.</th>
            </tr>
          </thead>
          <tbody>
            {data.segments.map((s, i) => (
              <tr key={i} className="border-b border-white/[0.04] last:border-0">
                <td className="py-1.5 pr-4 font-medium text-neutral-200">{s.segment}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(s.clicks)}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(s.impressions)}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatPct(s.ctr)}</td>
                <td className="py-1.5 text-right tabular-nums text-neutral-400">{formatPos(s.position)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Keywords
// ---------------------------------------------------------------------------

type PageKeywordsData = {
  page: string;
  keywords: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
};

function PageKeywordsView({ data }: { data: PageKeywordsData }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Keywords que trazem tráfego para <span className="font-mono text-neutral-400">{data.page}</span>
      </p>
      {data.keywords.length === 0 ? (
        <p className="text-xs text-neutral-500">Nenhuma keyword encontrada para esta página.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-left">
                <th className="pb-2 pr-4 text-xs font-medium text-neutral-400">Keyword</th>
                <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Clicks</th>
                <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">Impr.</th>
                <th className="pb-2 pr-4 text-right text-xs font-medium text-neutral-400">CTR</th>
                <th className="pb-2 text-right text-xs font-medium text-neutral-400">Pos.</th>
              </tr>
            </thead>
            <tbody>
              {data.keywords.map((kw, i) => (
                <tr key={i} className="border-b border-white/[0.04] last:border-0">
                  <td className="py-1.5 pr-4 font-medium text-neutral-200">{kw.query}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(kw.clicks)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatNum(kw.impressions)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-neutral-400">{formatPct(kw.ctr)}</td>
                  <td className="py-1.5 text-right tabular-nums text-neutral-400">{formatPos(kw.position)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Competitor Analysis
// ---------------------------------------------------------------------------

type CompetitorResultItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedDate: string | null;
  summary: string | null;
  highlights: string[];
};

function CompetitorAnalysisView({ results, topic }: { results: CompetitorResultItem[]; topic: string }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        {results.length} artigos encontrados sobre <span className="font-medium text-neutral-400">&ldquo;{topic}&rdquo;</span>
      </p>
      <div className="space-y-2">
        {results.map((r) => (
          <div
            key={r.id}
            className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-3"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 inline-block shrink-0 rounded-full border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-neutral-400">
                {r.source}
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-neutral-200 hover:text-violet-400 hover:underline"
                >
                  {r.title}
                </a>
                {r.publishedDate && (
                  <span className="ml-2 text-[10px] text-neutral-500">
                    {new Date(r.publishedDate).toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                )}
              </div>
            </div>
            {r.summary && (
              <p className="mt-1.5 text-xs leading-relaxed text-neutral-400 line-clamp-3">
                {r.summary}
              </p>
            )}
            {r.highlights.length > 0 && (
              <div className="mt-2 space-y-1">
                {r.highlights.slice(0, 2).map((h, i) => (
                  <blockquote
                    key={i}
                    className="border-l-2 border-violet-500/30 pl-2 text-[11px] italic text-neutral-500 line-clamp-2"
                  >
                    {h}
                  </blockquote>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scheduled Jobs sub-components
// ---------------------------------------------------------------------------

type ScheduledJobResult = {
  id: string;
  name: string;
  schedule: string;
  cron: string;
  webhook_url: string;
  enabled: boolean;
};

function ScheduledJobCreatedView({ job }: { job: ScheduledJobResult }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge className="border-emerald-500/30 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20">
          Criado
        </Badge>
        <span className="text-sm font-medium text-neutral-200">{job.name}</span>
      </div>
      <div className="space-y-1 text-xs text-neutral-400">
        <p>Frequência: <span className="text-neutral-300">{job.schedule}</span></p>
        <p>Cron: <span className="font-mono text-neutral-300">{job.cron}</span></p>
        <p>Webhook: <span className="font-mono text-neutral-300 break-all">{job.webhook_url}</span></p>
      </div>
    </div>
  );
}

type ScheduledJobListItem = {
  id: string;
  name: string;
  schedule_label: string;
  webhook_url: string;
  enabled: boolean;
  last_run_at: string | null;
};

function ScheduledJobListView({ jobs }: { jobs: ScheduledJobListItem[] }) {
  if (jobs.length === 0) {
    return <p className="text-xs text-neutral-500">Nenhum job agendado.</p>;
  }
  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <div
          key={job.id}
          className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] p-3"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${job.enabled ? "bg-emerald-400" : "bg-neutral-600"}`}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-neutral-200">{job.name}</p>
            <p className="text-[11px] text-neutral-500">
              {job.schedule_label}
              {job.last_run_at && (
                <> · Último run: {new Date(job.last_run_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</>
              )}
            </p>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-neutral-600 break-all max-w-[120px] truncate">
            {job.webhook_url}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export function ToolResultRenderer({ toolName, state, input: _input, output }: ToolResultProps) {
  const meta = TOOL_META[toolName] ?? { label: toolName, loadingMsg: `Executando ${toolName}...`, icon: Search };
  const Icon = meta.icon;

  // Loading state
  if (state !== "output-available" || !output) {
    return (
      <div className="my-1.5 flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-400" />
        <div>
          <p className="text-xs font-medium text-neutral-300">{meta.label}</p>
          <p className="text-[11px] text-neutral-500">{meta.loadingMsg}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (output.success === false) {
    return (
      <div className="my-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm">
        <p className="text-xs font-medium text-red-400">{meta.label} — Erro</p>
        <p className="mt-0.5 text-xs text-red-400/80">{String(output.message || "Erro desconhecido.")}</p>
      </div>
    );
  }

  // Success — wrap in a styled card
  const content = renderContent(toolName, output);
  if (!content) return null;

  return (
    <div className="my-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3.5 py-2">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-violet-500/10">
          <Icon className="h-3 w-3 text-violet-400" />
        </span>
        <span className="text-xs font-medium text-neutral-400">{meta.label}</span>
      </div>
      <div className="px-3.5 py-3">{content}</div>
    </div>
  );
}

function renderContent(toolName: string, output: Record<string, unknown>) {
  switch (toolName) {
    case "generateIdeas": {
      const results = output.results as IdeaResult[] | undefined;
      if (!results?.length) return <p className="text-xs text-neutral-500">Nenhuma ideia encontrada.</p>;
      return <IdeaResultsView results={results} />;
    }
    case "generateContentPlan": {
      const ideas = output.ideas as ContentPlanIdea[] | undefined;
      if (!ideas?.length) return <p className="text-xs text-neutral-500">Nenhuma ideia gerada.</p>;
      return (
        <ContentPlanView
          data={{
            summary: (output.summary as string) ?? "",
            ideas,
            dataCounts: (output.dataCounts as ContentPlanData["dataCounts"]) ?? {
              community: 0,
              opportunities: 0,
              decaying: 0,
              blogPosts: 0,
              keywords: 0,
            },
          }}
        />
      );
    }
    case "generateKeywords":
    case "getKeywordHistory": {
      const keywords = output.keywords as Keyword[] | undefined;
      if (!keywords?.length) return <p className="text-xs text-neutral-500">Nenhuma keyword encontrada.</p>;
      return <KeywordsTable keywords={keywords} />;
    }
    case "generateTitles": {
      const titles = output.titles as TitleItem[] | undefined;
      if (!titles?.length) return <p className="text-xs text-neutral-500">Nenhum título gerado.</p>;
      return <TitlesList titles={titles} />;
    }
    case "generateArticle": {
      const article = output.article as ArticlePreview | undefined;
      if (!article) return <p className="text-xs text-neutral-500">Nenhum artigo gerado.</p>;
      return <ArticlePreviewCard article={article} />;
    }
    case "generateSocialPosts": {
      const posts = output.posts as SocialPost[] | undefined;
      if (!posts?.length) return <p className="text-xs text-neutral-500">Nenhum post gerado.</p>;
      return <SocialPostsView posts={posts} />;
    }
    case "fetchBlogFeed": {
      const posts = output.posts as FeedPost[] | undefined;
      if (!posts?.length) return <p className="text-xs text-neutral-500">Nenhum post encontrado.</p>;
      return <BlogFeedList posts={posts} />;
    }
    case "getSearchPerformance": {
      const data = output as unknown as SearchPerfData;
      if (!data.totals) return <p className="text-xs text-neutral-500">Sem dados de performance.</p>;
      return <SearchPerformanceView data={data} />;
    }
    case "getTrafficOverview": {
      const data = output as unknown as TrafficData;
      if (!data.overview) return <p className="text-xs text-neutral-500">Sem dados de tráfego.</p>;
      return <TrafficOverviewView data={data} />;
    }
    case "getTopContent": {
      const data = output as unknown as TopContentData;
      if (!data.pages?.length) return <p className="text-xs text-neutral-500">Nenhuma página encontrada.</p>;
      return <TopContentView data={data} />;
    }
    case "getContentOpportunities": {
      const data = output as unknown as OpportunitiesData;
      return <ContentOpportunitiesView data={data} />;
    }
    case "comparePerformance": {
      const data = output as unknown as ComparePerformanceData;
      if (!data.search) return <p className="text-xs text-neutral-500">Sem dados de comparação.</p>;
      return <ComparePerformanceView data={data} />;
    }
    case "getContentDecay": {
      const data = output as unknown as ContentDecayData;
      return <ContentDecayView data={data} />;
    }
    case "getSearchBySegment": {
      const data = output as unknown as SearchBySegmentData;
      return <SearchBySegmentView data={data} />;
    }
    case "getPageKeywords": {
      const data = output as unknown as PageKeywordsData;
      if (!data.page) return <p className="text-xs text-neutral-500">Sem dados de keywords.</p>;
      return <PageKeywordsView data={data} />;
    }
    case "analyzeCompetitor": {
      const results = output.results as CompetitorResultItem[] | undefined;
      const topic = (output.topic as string) ?? "";
      if (!results?.length) return <p className="text-xs text-neutral-500">Nenhum conteúdo concorrente encontrado.</p>;
      return <CompetitorAnalysisView results={results} topic={topic} />;
    }
    case "scheduleJob": {
      const job = output.job as ScheduledJobResult | undefined;
      if (!job) return <p className="text-xs text-neutral-500">Nenhum job criado.</p>;
      return <ScheduledJobCreatedView job={job} />;
    }
    case "listScheduledJobs": {
      const jobs = output.jobs as ScheduledJobListItem[] | undefined;
      return <ScheduledJobListView jobs={jobs ?? []} />;
    }
    case "deleteScheduledJob": {
      return <p className="text-sm text-neutral-300">{String(output.message ?? "Job removido.")}</p>;
    }
    default:
      return (
        <pre className="overflow-x-auto text-xs text-neutral-400">
          {JSON.stringify(output, null, 2)}
        </pre>
      );
  }
}
