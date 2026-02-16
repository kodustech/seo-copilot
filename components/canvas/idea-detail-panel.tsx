"use client";

import { useState } from "react";
import {
  X,
  Star,
  ExternalLink,
  Loader2,
  Key,
  FileText,
  Newspaper,
  CheckCircle2,
  Swords,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { IdeaResult, IdeaAngle, CompetitorResult } from "@/lib/exa";
import type { KeywordSuggestion, TitleIdea, ArticlePost } from "@/lib/types";

const ANGLE_BADGES: Record<IdeaAngle, { label: string; className: string }> = {
  pain_points: { label: "Dores", className: "bg-red-500/20 text-red-300" },
  questions: { label: "Perguntas", className: "bg-blue-500/20 text-blue-300" },
  trends: { label: "Tendencias", className: "bg-emerald-500/20 text-emerald-300" },
  comparisons: { label: "Comparacoes", className: "bg-amber-500/20 text-amber-300" },
  best_practices: { label: "Boas Praticas", className: "bg-purple-500/20 text-purple-300" },
};

type Props = {
  idea: IdeaResult;
  favorited: boolean;
  onToggleFavorite: () => void;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function canvasPost(body: Record<string, unknown>) {
  const res = await fetch("/api/canvas/explore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro na requisição.");
  return data;
}

// ---------------------------------------------------------------------------
// Pipeline step component
// ---------------------------------------------------------------------------

function PipelineButton({
  onClick,
  disabled,
  loading,
  done,
  doneLabel,
  loadingLabel,
  idleLabel,
  icon: Icon,
  doneColor = "text-emerald-400",
}: {
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  done: boolean;
  doneLabel: string;
  loadingLabel: string;
  idleLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  doneColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/[0.08] disabled:opacity-50"
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {loadingLabel}
        </>
      ) : done ? (
        <>
          <Icon className={`h-4 w-4 ${doneColor}`} />
          {doneLabel}
        </>
      ) : (
        <>
          <Icon className="h-4 w-4" />
          {idleLabel}
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function IdeaDetailPanel({ idea, favorited, onToggleFavorite, onClose }: Props) {
  // Keywords
  const [keywords, setKeywords] = useState<KeywordSuggestion[] | null>(null);
  const [keywordsLoading, setKeywordsLoading] = useState(false);
  const [keywordsError, setKeywordsError] = useState<string | null>(null);

  // Titles
  const [titles, setTitles] = useState<TitleIdea[] | null>(null);
  const [titlesLoading, setTitlesLoading] = useState(false);
  const [titlesError, setTitlesError] = useState<string | null>(null);
  const [selectedTitle, setSelectedTitle] = useState<TitleIdea | null>(null);

  // Article
  const [article, setArticle] = useState<ArticlePost | null>(null);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);

  // Competitors
  const [competitors, setCompetitors] = useState<CompetitorResult[] | null>(null);
  const [competitorsLoading, setCompetitorsLoading] = useState(false);
  const [competitorsError, setCompetitorsError] = useState<string | null>(null);
  const [competitorsOpen, setCompetitorsOpen] = useState(false);

  const angleBadge = ANGLE_BADGES[idea.angle];

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleGenerateKeywords() {
    setKeywordsLoading(true);
    setKeywordsError(null);
    try {
      const data = await canvasPost({ action: "keywords", idea: idea.title });
      const taskId = data.taskId as number;

      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const statusData = await canvasPost({ action: "keywords_status", taskId });
        if (statusData.ready && statusData.keywords) {
          setKeywords(statusData.keywords);
          return;
        }
      }
      throw new Error("Timeout: keywords demoraram demais.");
    } catch (err) {
      setKeywordsError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setKeywordsLoading(false);
    }
  }

  async function handleGenerateTitles() {
    if (!keywords?.length) return;
    setTitlesLoading(true);
    setTitlesError(null);
    try {
      const topKeywords = keywords.slice(0, 5).map((k) => ({ keyword: k.phrase }));
      const data = await canvasPost({ action: "titles", keywords: topKeywords });
      setTitles(data.titles);
    } catch (err) {
      setTitlesError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setTitlesLoading(false);
    }
  }

  async function handleGenerateArticle() {
    if (!selectedTitle || !keywords?.length) return;
    setArticleLoading(true);
    setArticleError(null);
    try {
      const data = await canvasPost({
        action: "article",
        title: selectedTitle.text,
        keyword: keywords[0].phrase,
        useResearch: true,
      });
      const taskId = data.taskId as number;

      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const statusData = await canvasPost({ action: "article_status", taskId });
        if (statusData.ready && statusData.articles?.length) {
          setArticle(statusData.articles[0]);
          return;
        }
      }
      throw new Error("Timeout: artigo demorou demais.");
    } catch (err) {
      setArticleError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setArticleLoading(false);
    }
  }

  async function handleAnalyzeCompetitors() {
    setCompetitorsLoading(true);
    setCompetitorsError(null);
    try {
      const data = await canvasPost({ action: "competitors", topic: idea.title });
      setCompetitors(data.results);
      setCompetitorsOpen(true);
    } catch (err) {
      setCompetitorsError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setCompetitorsLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="fixed right-0 top-0 z-50 flex h-full w-[400px] flex-col border-l border-white/[0.06] bg-neutral-950/95 backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
        <span className="text-sm font-medium text-neutral-400">Detalhes da Ideia</span>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-neutral-500 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        {/* Title + favorite */}
        <div className="flex items-start gap-3">
          <h3 className="flex-1 text-base font-semibold leading-snug text-white">
            {idea.title}
          </h3>
          <button onClick={onToggleFavorite} className="shrink-0 p-0.5">
            <Star
              className={`h-5 w-5 ${
                favorited
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-neutral-600 hover:text-neutral-300"
              }`}
            />
          </button>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${angleBadge.className}`}>
            {angleBadge.label}
          </span>
          <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-neutral-300">
            {idea.source}
          </span>
          <a
            href={idea.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-neutral-500 transition hover:text-white"
          >
            <ExternalLink className="h-3 w-3" />
            Abrir
          </a>
        </div>

        {/* Summary */}
        {idea.summary && (
          <div>
            <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-neutral-500">
              Resumo
            </h4>
            <p className="text-sm leading-relaxed text-neutral-300">{idea.summary}</p>
          </div>
        )}

        {/* Highlights */}
        {idea.highlights.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-neutral-500">
              Destaques
            </h4>
            <div className="space-y-2">
              {idea.highlights.map((h, i) => (
                <blockquote
                  key={i}
                  className="border-l-2 border-violet-500/40 pl-3 text-sm italic leading-relaxed text-neutral-400"
                >
                  {h}
                </blockquote>
              ))}
            </div>
          </div>
        )}

        {/* =============================================================== */}
        {/* PIPELINE: Keywords → Titles → Article → Published              */}
        {/* =============================================================== */}

        {/* Step 1: Keywords */}
        <div className="border-t border-white/[0.06] pt-4">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
              Passo 1
            </span>
            {keywords && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
          </div>
          <PipelineButton
            onClick={handleGenerateKeywords}
            disabled={keywordsLoading || keywords !== null}
            loading={keywordsLoading}
            done={keywords !== null}
            doneLabel={`${keywords?.length ?? 0} keywords encontradas`}
            loadingLabel="Gerando keywords..."
            idleLabel="Gerar Keywords"
            icon={Key}
          />
          {keywordsError && <p className="mt-2 text-xs text-red-400">{keywordsError}</p>}
          {keywords && keywords.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {keywords.map((kw) => (
                <div
                  key={kw.id}
                  className="flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2"
                >
                  <span className="text-sm text-neutral-200">{kw.phrase}</span>
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    {kw.volume > 0 && <span>Vol: {kw.volume}</span>}
                    {kw.difficulty > 0 && <span>KD: {kw.difficulty}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Step 2: Titles */}
        {keywords && keywords.length > 0 && (
          <div className="border-t border-white/[0.06] pt-4">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
                Passo 2
              </span>
              {titles && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
            </div>
            <PipelineButton
              onClick={handleGenerateTitles}
              disabled={titlesLoading || titles !== null}
              loading={titlesLoading}
              done={titles !== null}
              doneLabel={`${titles?.length ?? 0} titulos gerados`}
              loadingLabel="Gerando titulos..."
              idleLabel="Gerar Titulos"
              icon={FileText}
              doneColor="text-violet-400"
            />
            {titlesError && <p className="mt-2 text-xs text-red-400">{titlesError}</p>}
            {titles && titles.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {titles.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTitle(selectedTitle?.id === t.id ? null : t)}
                    className={`w-full rounded-lg px-3 py-2 text-left transition ${
                      selectedTitle?.id === t.id
                        ? "bg-violet-600/20 ring-1 ring-violet-500/40"
                        : "bg-white/[0.04] hover:bg-white/[0.08]"
                    }`}
                  >
                    <span className="text-sm text-neutral-200">{t.text}</span>
                  </button>
                ))}
                {!selectedTitle && (
                  <p className="text-xs text-neutral-600">Selecione um titulo para continuar</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 3: Generate Article */}
        {selectedTitle && (
          <div className="border-t border-white/[0.06] pt-4">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
                Passo 3
              </span>
              {article && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
            </div>
            <PipelineButton
              onClick={handleGenerateArticle}
              disabled={articleLoading || article !== null}
              loading={articleLoading}
              done={article !== null}
              doneLabel="Artigo gerado!"
              loadingLabel="Gerando artigo (~1-3 min)..."
              idleLabel={`Gerar Artigo: "${selectedTitle.text.slice(0, 40)}..."`}
              icon={Newspaper}
            />
            {articleError && <p className="mt-2 text-xs text-red-400">{articleError}</p>}
            {article && (
              <div className="mt-3 rounded-lg bg-white/[0.04] p-4 space-y-3">
                <h4 className="text-sm font-semibold text-white">{article.title}</h4>
                {article.url && (
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/30"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Ver no WordPress
                  </a>
                )}
                {article.status && (
                  <span className="inline-block rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-neutral-300">
                    Status: {article.status}
                  </span>
                )}
                {article.content && (
                  <div className="max-h-48 overflow-y-auto rounded border border-white/[0.06] bg-black/30 p-3">
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-400">
                      {article.content.slice(0, 1000)}
                      {article.content.length > 1000 && "..."}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* =============================================================== */}
        {/* COMPETITOR ANALYSIS                                             */}
        {/* =============================================================== */}
        <div className="border-t border-white/[0.06] pt-4">
          <PipelineButton
            onClick={handleAnalyzeCompetitors}
            disabled={competitorsLoading || competitors !== null}
            loading={competitorsLoading}
            done={competitors !== null}
            doneLabel={`${competitors?.length ?? 0} concorrentes encontrados`}
            loadingLabel="Analisando concorrencia..."
            idleLabel="Analisar Concorrencia"
            icon={Swords}
            doneColor="text-amber-400"
          />
          {competitorsError && (
            <p className="mt-2 text-xs text-red-400">{competitorsError}</p>
          )}
          {competitors && competitors.length > 0 && (
            <div className="mt-3">
              <button
                onClick={() => setCompetitorsOpen(!competitorsOpen)}
                className="mb-2 flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300"
              >
                {competitorsOpen ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {competitorsOpen ? "Recolher" : "Expandir"} resultados
              </button>
              {competitorsOpen && (
                <div className="space-y-3">
                  {competitors.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h5 className="line-clamp-2 text-sm font-medium text-white">
                          {c.title}
                        </h5>
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-neutral-600 hover:text-neutral-300"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      <span className="inline-block rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-neutral-400">
                        {c.source}
                      </span>
                      {c.summary && (
                        <p className="text-xs leading-relaxed text-neutral-400">
                          {c.summary}
                        </p>
                      )}
                      {c.highlights.length > 0 && (
                        <div className="space-y-1">
                          {c.highlights.slice(0, 2).map((h, i) => (
                            <blockquote
                              key={i}
                              className="border-l-2 border-amber-500/30 pl-2 text-[11px] italic text-neutral-500"
                            >
                              {h}
                            </blockquote>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
