'use client';

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownWideNarrow,
  ArrowRight,
  CheckCircle2,
  FileText,
  Lightbulb,
  Loader2,
  NotebookPen,
  Shuffle,
  Sparkles,
} from "lucide-react";

import type { KeywordSuggestion, TitleIdea } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Banner =
  | { intent: "success" | "info"; message: string }
  | { intent: "error"; message: string };

export function SeoWorkspace() {
  const [idea, setIdea] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [keywords, setKeywords] = useState<KeywordSuggestion[]>([]);
  const [titles, setTitles] = useState<TitleIdea[]>([]);
  const [articleContent, setArticleContent] = useState("");
  const [keywordLimit, setKeywordLimit] = useState(12);
  const [locationCode, setLocationCode] = useState("2076");
  const [languageCode, setLanguageCode] = useState("pt");
  const [useResearch, setUseResearch] = useState(false);
  const [researchInstructions, setResearchInstructions] = useState("");
  const [articleKeywordId, setArticleKeywordId] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [keywordBriefings, setKeywordBriefings] = useState<Record<string, string>>({});
  const [keywordTaskId, setKeywordTaskId] = useState<number | null>(null);
  const [isPollingTask, setIsPollingTask] = useState(false);
  const [keywordTaskStatus, setKeywordTaskStatus] = useState<string | null>(
    null,
  );
  const [articleTaskId, setArticleTaskId] = useState<number | null>(null);
  const [articleTaskStatus, setArticleTaskStatus] = useState<string | null>(null);
  const [isPollingArticle, setIsPollingArticle] = useState(false);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedTitleId, setSelectedTitleId] = useState<string | null>(null);
  const [loading, setLoading] = useState({
    keywords: false,
    titles: false,
    content: false,
  });
  const [banner, setBanner] = useState<Banner | null>(null);
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyKeywords, setHistoryKeywords] = useState<KeywordSuggestion[]>([]);
  const [historySelectedIds, setHistorySelectedIds] = useState<Set<string>>(
    new Set(),
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySearchTerm, setHistorySearchTerm] = useState("");
  const [historySortField, setHistorySortField] = useState<"volume" | "cpc" | "difficulty">("volume");
  const [historySortOrder, setHistorySortOrder] = useState<"desc" | "asc">("desc");
  const [manualKeyword, setManualKeyword] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [reverseSearchTitle, setReverseSearchTitle] = useState("");
  const [activeTab, setActiveTab] = useState<"complete" | "reverse" | "manual">("complete");

  const selectedKeywords = useMemo(
    () => keywords.filter((keyword) => selectedKeywordIds.has(keyword.id)),
    [keywords, selectedKeywordIds],
  );

  const selectedTitle = useMemo(
    () => titles.find((title) => title.id === selectedTitleId) ?? null,
    [titles, selectedTitleId],
  );

  const keywordStats = useMemo(() => {
    if (!keywords.length) {
      return { avgVolume: 0, avgDifficulty: 0 };
    }
    const totals = keywords.reduce(
      (acc, item) => {
        acc.volume += item.volume;
        acc.difficulty += item.difficulty;
        return acc;
      },
      { volume: 0, difficulty: 0 },
    );
    return {
      avgVolume: Math.round(totals.volume / keywords.length),
      avgDifficulty: Math.round(totals.difficulty / keywords.length),
    };
  }, [keywords]);

  const orderedKeywords = useMemo(() => {
    if (!keywords.length) {
      return [];
    }
    return [...keywords].sort((a, b) =>
      sortOrder === "desc" ? b.volume - a.volume : a.volume - b.volume,
    );
  }, [keywords, sortOrder]);

  const filteredAndOrderedHistoryKeywords = useMemo(() => {
    if (!historyKeywords.length) {
      return [];
    }
    
    let filtered = historyKeywords;
    
    if (historySearchTerm.trim()) {
      const search = historySearchTerm.toLowerCase();
      filtered = historyKeywords.filter((keyword) =>
        keyword.phrase.toLowerCase().includes(search) ||
        keyword.idea?.toLowerCase().includes(search) ||
        keyword.language?.toLowerCase().includes(search)
      );
    }
    
    return [...filtered].sort((a, b) => {
      let aVal = 0;
      let bVal = 0;
      
      if (historySortField === "volume") {
        aVal = a.volume ?? 0;
        bVal = b.volume ?? 0;
      } else if (historySortField === "cpc") {
        aVal = a.cpc ?? 0;
        bVal = b.cpc ?? 0;
      } else if (historySortField === "difficulty") {
        aVal = a.difficulty ?? 0;
        bVal = b.difficulty ?? 0;
      }
      
      return historySortOrder === "desc" ? bVal - aVal : aVal - bVal;
    });
  }, [historyKeywords, historySearchTerm, historySortField, historySortOrder]);

  useEffect(() => {
    if (!selectedKeywords.length) {
      setArticleKeywordId(null);
      return;
    }
    const exists = selectedKeywords.some((item) => item.id === articleKeywordId);
    if (!exists) {
      setArticleKeywordId(selectedKeywords[0].id);
    }
  }, [selectedKeywords, articleKeywordId]);

  useEffect(() => {
    if (!keywordTaskId || !isPollingTask) {
      return;
    }

    let isCancelled = false;

    async function pollTask() {
      try {
        const data = await getJson<{
          ready: boolean;
          keywords?: KeywordSuggestion[];
        }>(`/api/keywords?taskId=${keywordTaskId}`);

        if (isCancelled) {
          return;
        }

        if (!data.ready) {
          setKeywordTaskStatus("in-progress");
          return;
        }

        if (!data.keywords || data.keywords.length === 0) {
          setIsPollingTask(false);
          setKeywordTaskStatus(null);
          setKeywordTaskId(null);
          setLoading((state) => ({ ...state, keywords: false }));
          setBanner({
            intent: "error",
            message: "Task concluída, mas não recebemos keywords.",
          });
          return;
        }

        setKeywords(data.keywords);
        setSortOrder("desc");
        setSelectedKeywordIds(new Set());
        setTitles([]);
        setSelectedTitleId(null);
        setArticleContent("");
        setLoading((state) => ({ ...state, keywords: false }));
        setIsPollingTask(false);
        setKeywordTaskId(null);
        setKeywordTaskStatus(null);
        setBanner({
          intent: "success",
          message: `Geramos ${data.keywords.length} keywords fresquinhas.`,
        });
      } catch (error) {
        if (isCancelled) {
          return;
        }
        setIsPollingTask(false);
        setKeywordTaskId(null);
        setKeywordTaskStatus(null);
        setLoading((state) => ({ ...state, keywords: false }));
        setBanner({
          intent: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro ao consultar a task do copiloto.",
        });
      }
    }

    pollTask();
    const interval = setInterval(pollTask, 3000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [keywordTaskId, isPollingTask]);

  useEffect(() => {
    if (!articleTaskId || !isPollingArticle) {
      return;
    }

    let isCancelled = false;

    async function pollArticleTask() {
      try {
        const data = await getJson<{
          ready: boolean;
          articles?: { id: string; content?: string; url?: string }[];
        }>(`/api/articles?taskId=${articleTaskId}`);

        if (isCancelled) {
          return;
        }

        if (!data.ready) {
          setArticleTaskStatus("in-progress");
          return;
        }

        if (!data.articles || data.articles.length === 0) {
          setIsPollingArticle(false);
          setArticleTaskStatus(null);
          setArticleTaskId(null);
          setBanner({
            intent: "error",
            message: "Task concluída, mas não recebemos o artigo.",
          });
          return;
        }

        const first = data.articles[0];
        const link = first.url ?? first.content ?? "";
        setArticleContent(link);
        setIsPollingArticle(false);
        setArticleTaskStatus(null);
        setArticleTaskId(null);
        setBanner({
          intent: "info",
          message: "Artigo pronto!",
        });
      } catch (error) {
        if (isCancelled) {
          return;
        }
        setIsPollingArticle(false);
        setArticleTaskStatus(null);
        setArticleTaskId(null);
        setBanner({
          intent: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro ao consultar o artigo.",
        });
      }
    }

    pollArticleTask();
    const interval = setInterval(pollArticleTask, 4000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [articleTaskId, isPollingArticle]);

  useEffect(() => {
    if (!historyDialogOpen || historyLoaded) {
      return;
    }
    let cancelled = false;

    async function loadHistory() {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const payload = await getJson<{ keywords: KeywordSuggestion[] }>(
          "/api/keywords/history",
        );
        if (!cancelled) {
          setHistoryKeywords(payload.keywords ?? []);
          setHistoryLoaded(true);
        }
      } catch (error) {
        if (!cancelled) {
          setHistoryError(
            error instanceof Error
              ? error.message
              : "Não conseguimos buscar o histórico agora.",
          );
          setHistoryLoaded(false);
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [historyDialogOpen, historyLoaded]);

  async function handleKeywordGeneration(mode: "idea" | "random") {
    if (mode === "idea" && !idea.trim()) {
      setBanner({
        intent: "error",
        message: "Compartilhe a ideia principal antes de gerar keywords.",
      });
      return;
    }

    setBanner(null);
    setLoading((state) => ({ ...state, keywords: true }));
    setKeywordTaskStatus(null);
    try {
      const ticket = await postJson<{
        taskId: number;
        status?: string | null;
      }>("/api/keywords", {
        idea: mode === "idea" ? idea.trim() : undefined,
        limit: keywordLimit,
        locationCode,
        language: languageCode,
      });

      if (!ticket.taskId) {
        throw new Error("Não recebemos o identificador da task.");
      }

      setKeywordTaskId(ticket.taskId);
      setKeywordTaskStatus(ticket.status ?? "in-progress");
      setIsPollingTask(true);
      setKeywords([]);
      setSortOrder("desc");
      setSelectedKeywordIds(new Set());
      setTitles([]);
      setSelectedTitleId(null);
      setArticleContent("");
      setBanner({
        intent: "info",
        message: `Task #${ticket.taskId} enfileirada. Avisamos quando as keywords chegarem.`,
      });
    } catch (error) {
      setLoading((state) => ({ ...state, keywords: false }));
      setIsPollingTask(false);
      setKeywordTaskId(null);
      setKeywordTaskStatus(null);
      setBanner({
        intent: "error",
        message:
          error instanceof Error
            ? error.message
            : "Não conseguimos falar com o copiloto agora.",
      });
    }
  }

  async function handleGenerateTitles() {
    if (!selectedKeywords.length) {
      setBanner({
        intent: "error",
        message: "Selecione uma ou mais keywords para inspirar os títulos.",
      });
      return;
    }

    setBanner(null);
    setLoading((state) => ({ ...state, titles: true }));
    try {
      const keywordPayload = selectedKeywords.map((keyword) => ({
        keyword: keyword.phrase,
        instruction: keywordBriefings[keyword.id]?.trim() || undefined,
      }));

      const payload = await postJson<{ titles: TitleIdea[] }>(
        "/api/titles",
        {
          keywords: keywordPayload,
        },
      );
      setTitles(payload.titles);
      setSelectedTitleId(payload.titles[0]?.id ?? null);
      setArticleContent("");
      setBanner({
        intent: "success",
        message: `Geramos ${payload.titles.length} opções de título.`,
      });
    } catch (error) {
      setBanner({
        intent: "error",
        message:
          error instanceof Error
            ? error.message
            : "Não conseguimos gerar títulos agora.",
      });
    } finally {
      setLoading((state) => ({ ...state, titles: false }));
    }
  }

  async function handleGenerateArticle() {
    if (!selectedTitle) {
      setBanner({
        intent: "error",
        message: "Escolha um título antes de pedir o artigo.",
      });
      return;
    }

    if (!articleKeywordId) {
      setBanner({
        intent: "error",
        message: "Escolha qual keyword deve guiar o artigo.",
      });
      return;
    }

    const keywordEntry = keywords.find((item) => item.id === articleKeywordId);
    if (!keywordEntry) {
      setBanner({
        intent: "error",
        message: "Não encontramos a keyword selecionada.",
      });
      return;
    }

    setBanner(null);
    setLoading((state) => ({ ...state, content: true }));
    try {
      const ticket = await postJson<{ taskId: number; status?: string | null }>(
        "/api/articles",
        {
          title: selectedTitle.text,
          keyword: keywordEntry.phrase,
          keywordId: keywordEntry.id,
          useResearch,
          researchInstructions,
          customInstructions,
          categories: selectedCategories,
        },
      );
      if (!ticket.taskId) {
        throw new Error("Não recebemos o identificador da task de artigo.");
      }
      setArticleContent("");
      setArticleTaskId(ticket.taskId);
      setArticleTaskStatus(ticket.status ?? "in-progress");
      setIsPollingArticle(true);
      setBanner({
        intent: "info",
        message: `Task de artigo #${ticket.taskId} enfileirada. Avisamos quando ficar pronta.`,
      });
    } catch (error) {
      setBanner({
        intent: "error",
        message:
          error instanceof Error
            ? error.message
            : "Não conseguimos gerar o artigo agora.",
      });
    } finally {
      setLoading((state) => ({ ...state, content: false }));
    }
  }

  async function handleGenerateArticleManual() {
    if (!manualTitle.trim()) {
      setBanner({
        intent: "error",
        message: "Digite um título para o artigo.",
      });
      return;
    }

    if (!manualKeyword.trim()) {
      setBanner({
        intent: "error",
        message: "Digite a keyword principal.",
      });
      return;
    }

    setBanner(null);
    setLoading((state) => ({ ...state, content: true }));
    try {
      const ticket = await postJson<{ taskId: number; status?: string | null }>(
        "/api/articles",
        {
          title: manualTitle.trim(),
          keyword: manualKeyword.trim(),
          keywordId: `manual-${Date.now()}`,
          useResearch,
          researchInstructions,
          customInstructions,
          categories: selectedCategories,
        },
      );
      if (!ticket.taskId) {
        throw new Error("Não recebemos o identificador da task de artigo.");
      }
      setArticleContent("");
      setArticleTaskId(ticket.taskId);
      setArticleTaskStatus(ticket.status ?? "in-progress");
      setIsPollingArticle(true);
      setBanner({
        intent: "info",
        message: `Task de artigo #${ticket.taskId} enfileirada. Avisamos quando ficar pronta.`,
      });
    } catch (error) {
      setBanner({
        intent: "error",
        message:
          error instanceof Error
            ? error.message
            : "Não conseguimos gerar o artigo agora.",
      });
    } finally {
      setLoading((state) => ({ ...state, content: false }));
    }
  }

  async function handleReverseSearchKeywords() {
    if (!reverseSearchTitle.trim()) {
      setBanner({
        intent: "error",
        message: "Digite um título para buscar keywords relacionadas.",
      });
      return;
    }

    setBanner(null);
    setLoading((state) => ({ ...state, keywords: true }));
    setKeywordTaskStatus(null);
    try {
      const ticket = await postJson<{
        taskId: number;
        status?: string | null;
      }>("/api/keywords", {
        idea: `Encontre keywords relacionadas ao seguinte título: "${reverseSearchTitle.trim()}"`,
        limit: keywordLimit,
        locationCode,
        language: languageCode,
      });

      if (!ticket.taskId) {
        throw new Error("Não recebemos o identificador da task.");
      }

      setKeywordTaskId(ticket.taskId);
      setKeywordTaskStatus(ticket.status ?? "in-progress");
      setIsPollingTask(true);
      setKeywords([]);
      setSortOrder("desc");
      setSelectedKeywordIds(new Set());
      setTitles([]);
      setSelectedTitleId(null);
      setArticleContent("");
      setBanner({
        intent: "info",
        message: `Buscando keywords relacionadas ao título. Task #${ticket.taskId} enfileirada.`,
      });
    } catch (error) {
      setLoading((state) => ({ ...state, keywords: false }));
      setIsPollingTask(false);
      setKeywordTaskId(null);
      setKeywordTaskStatus(null);
      setBanner({
        intent: "error",
        message:
          error instanceof Error
            ? error.message
            : "Não conseguimos buscar keywords agora.",
      });
    }
  }

  function toggleKeyword(id: string) {
    setSelectedKeywordIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSortOrder() {
    setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
  }

  function toggleHistoryKeyword(id: string) {
    setHistorySelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAllHistoryKeywords() {
    setHistorySelectedIds((prev) => {
      if (prev.size === filteredAndOrderedHistoryKeywords.length) {
        return new Set();
      }
      return new Set(filteredAndOrderedHistoryKeywords.map((keyword) => keyword.id));
    });
  }

  function toggleHistorySort(field: "volume" | "cpc" | "difficulty") {
    if (historySortField === field) {
      setHistorySortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setHistorySortField(field);
      setHistorySortOrder("desc");
    }
  }

  function handleApplyHistorySelection() {
    const selected = historyKeywords.filter((keyword) =>
      historySelectedIds.has(keyword.id),
    );
    if (!selected.length) {
      setHistoryError("Selecione ao menos uma keyword do histórico.");
      return;
    }

    const merged = [...selected, ...keywords];
    const unique = new Map<string, KeywordSuggestion>();
    for (const keyword of merged) {
      unique.set(keyword.id, keyword);
    }
    const nextKeywords = Array.from(unique.values());
    setKeywords(nextKeywords);
    setSelectedKeywordIds(new Set(selected.map((item) => item.id)));
    setHistorySelectedIds(new Set());
    setHistoryDialogOpen(false);
    setBanner({
      intent: "info",
      message: `Adicionamos ${selected.length} keywords do histórico.`,
    });
  }

  function toggleAllKeywords() {
    setSelectedKeywordIds((current) => {
      if (current.size === keywords.length) {
        return new Set();
      }
      return new Set(keywords.map((keyword) => keyword.id));
    });
  }

  function resetWorkspace() {
    setIdea("");
    setCustomInstructions("");
    setKeywords([]);
    setSortOrder("desc");
    setTitles([]);
    setArticleContent("");
    setSelectedKeywordIds(new Set());
    setSelectedTitleId(null);
    setKeywordBriefings({});
    setLocationCode("2076");
    setLanguageCode("pt");
    setUseResearch(false);
    setResearchInstructions("");
    setSelectedCategories([]);
    setArticleKeywordId(null);
    setArticleTaskId(null);
    setArticleTaskStatus(null);
    setIsPollingArticle(false);
    setKeywordTaskId(null);
    setIsPollingTask(false);
    setKeywordTaskStatus(null);
    setLoading((state) => ({ ...state, keywords: false }));
    setBanner({
      intent: "info",
      message: "Workspace limpo. Bora criar outra estratégia?",
    });
  }


  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-50 to-white px-4 py-10 text-neutral-900 dark:from-neutral-950 dark:to-neutral-900 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="rounded-full px-3 py-1 text-sm">
              Copiloto de SEO
            </Badge>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Ideias → palavras → títulos → artigo
            </p>
          </div>
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-neutral-900 dark:text-white">
              Um fluxo Notion-like para tirar estratégias do papel
            </h1>
            <p className="mt-3 max-w-3xl text-lg text-neutral-600 dark:text-neutral-300">
              Traga uma ideia ou peça algo aleatório. O copiloto gera keywords,
              salva tudo no Supabase e te guia até o artigo final.
            </p>
          </div>
        </header>

        {banner && (
          <Card
            className={`border-0 shadow-sm ${
              banner.intent === "error"
                ? "bg-red-50 dark:bg-red-950/30"
                : banner.intent === "success"
                  ? "bg-green-50 dark:bg-emerald-950/30"
                  : "bg-neutral-50 dark:bg-neutral-900"
            }`}
          >
            <CardContent className="flex items-center gap-3 py-4 text-sm text-neutral-700 dark:text-neutral-300">
              {banner.intent === "error" ? (
                <FileText className="h-4 w-4 text-red-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              )}
              <span>{banner.message}</span>
            </CardContent>
          </Card>
        )}

        {keywordTaskId && isPollingTask && (
          <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
            <CardContent className="flex items-center gap-4 py-5 text-sm text-neutral-700 dark:text-neutral-200">
              <Loader2 className="h-5 w-5 animate-spin text-neutral-900 dark:text-white" />
              <div>
                <p className="font-semibold text-neutral-900 dark:text-white">
                  Processando task #{keywordTaskId}
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Status: {keywordTaskStatus ?? "in-progress"} • Assim que chegar, atualizamos a lista de keywords.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="w-full">
          <TabsList className="grid w-full grid-cols-3 rounded-2xl bg-neutral-100/80 p-1 dark:bg-neutral-800">
            <TabsTrigger value="complete" className="rounded-xl data-[state=active]:bg-white dark:data-[state=active]:bg-neutral-900">
              Fluxo Completo
            </TabsTrigger>
            <TabsTrigger value="reverse" className="rounded-xl data-[state=active]:bg-white dark:data-[state=active]:bg-neutral-900">
              Título → Keywords
            </TabsTrigger>
            <TabsTrigger value="manual" className="rounded-xl data-[state=active]:bg-white dark:data-[state=active]:bg-neutral-900">
              Manual Rápido
            </TabsTrigger>
          </TabsList>

          <TabsContent value="complete" className="mt-8 space-y-8">
        <Card className="border-0 bg-white/80 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-2xl">Ponto de partida</CardTitle>
              <CardDescription className="text-base">
                Compartilhe o contexto ou deixe o copiloto surpreender com novas
                oportunidades.
              </CardDescription>
            </div>
            <div className="flex items-center gap-4 rounded-2xl border border-neutral-200/80 px-4 py-2 text-sm dark:border-white/10">
              <div>
                <p className="text-xs uppercase text-neutral-500">
                  Keywords salvas
                </p>
                <p className="text-lg font-semibold text-neutral-900 dark:text-white">
                  {keywords.length}
                </p>
              </div>
              <Separator orientation="vertical" className="h-8" />
              <div>
                <p className="text-xs uppercase text-neutral-500">Seleções</p>
                <p className="text-lg font-semibold text-neutral-900 dark:text-white">
                  {selectedKeywords.length}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <Textarea
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="Ex.: Quero falar sobre tendências de IA em e-commerce focadas em conversão..."
              className="min-h-[120px] resize-none bg-neutral-50/70 text-base dark:bg-neutral-800"
            />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed border-neutral-200/80 bg-white/70 p-4 text-sm dark:border-white/10 dark:bg-neutral-900/50">
                <div>
                  <p className="text-xs uppercase text-neutral-500">Quantidade desejada</p>
                  <p className="text-sm text-neutral-600 dark:text-neutral-300">
                    Diga quantas ideias de keyword quer receber (5 a 50).
                  </p>
                </div>
                <Input
                  type="number"
                  min={5}
                  max={50}
                  value={keywordLimit}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) {
                      return;
                    }
                    const clamped = Math.min(50, Math.max(5, Math.round(next)));
                    setKeywordLimit(clamped);
                  }}
                  className="w-24 text-center text-base font-semibold"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed border-neutral-200/80 bg-white/70 p-4 text-sm dark:border-white/10 dark:bg-neutral-900/50">
                <div>
                  <p className="text-xs uppercase text-neutral-500">País</p>
                  <p className="text-sm text-neutral-600 dark:text-neutral-300">
                    Escolha o mercado alvo para gerar as keywords.
                  </p>
                </div>
                <Select value={locationCode} onValueChange={setLocationCode}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2076">Brasil</SelectItem>
                    <SelectItem value="2840">Estados Unidos</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed border-neutral-200/80 bg-white/70 p-4 text-sm dark:border-white/10 dark:bg-neutral-900/50">
                <div>
                  <p className="text-xs uppercase text-neutral-500">Idioma</p>
                  <p className="text-sm text-neutral-600 dark:text-neutral-300">
                    Defina em qual idioma o copiloto pesquisa.
                  </p>
                </div>
                <Select value={languageCode} onValueChange={setLanguageCode}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Idioma" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pt">Português</SelectItem>
                    <SelectItem value="en">Inglês</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="default"
                className="flex-1 min-w-[220px] justify-between rounded-2xl bg-neutral-900 px-6 py-6 text-base font-medium hover:bg-neutral-800 dark:bg-white dark:text-neutral-900"
                onClick={() => handleKeywordGeneration("idea")}
                disabled={loading.keywords || !idea.trim()}
              >
                <div className="flex items-center gap-3">
                  {loading.keywords ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Sparkles className="h-5 w-5" />
                  )}
                  <span>Gerar keywords da minha ideia</span>
                </div>
                <ArrowRight className="h-5 w-5" />
              </Button>
              <Button
                variant="outline"
                className="flex-1 min-w-[220px] justify-between rounded-2xl border-dashed px-6 py-6 text-base font-medium"
                onClick={() => handleKeywordGeneration("random")}
                disabled={loading.keywords}
              >
                <div className="flex items-center gap-3">
                  {loading.keywords ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Shuffle className="h-5 w-5" />
                  )}
                  <span>Quero ideias totalmente novas</span>
                </div>
                <ArrowRight className="h-5 w-5" />
              </Button>
              <Button
                variant="secondary"
                className="flex-1 min-w-[220px] justify-between rounded-2xl border-dashed px-6 py-6 text-base font-medium"
                onClick={() => setHistoryDialogOpen(true)}
              >
                <div className="flex items-center gap-3">
                  <Sparkles className="h-5 w-5" />
                  <span>Explorar histórico salvo</span>
                </div>
                <ArrowRight className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                className="rounded-2xl px-6 py-6 text-base font-normal text-neutral-500 hover:text-neutral-900"
                onClick={resetWorkspace}
                type="button"
              >
                Limpar workspace
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-2xl">Keywords priorizadas</CardTitle>
              <CardDescription className="text-base">
                Clique para selecionar e use o insight médio abaixo para guiar o
                próximo passo.
              </CardDescription>
            </div>
            <div className="flex items-center gap-4 text-sm text-neutral-500 dark:text-neutral-400">
              <div className="rounded-2xl bg-neutral-100 px-4 py-2 text-center dark:bg-neutral-800">
                <p className="text-xs uppercase">Volume médio</p>
                <p className="text-lg font-semibold text-neutral-900 dark:text-white">
                  {keywordStats.avgVolume || "—"}
                </p>
              </div>
              <div className="rounded-2xl bg-neutral-100 px-4 py-2 text-center dark:bg-neutral-800">
                <p className="text-xs uppercase">Dificuldade média</p>
                <p className="text-lg font-semibold text-neutral-900 dark:text-white">
                  {keywordStats.avgDifficulty || "—"}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {keywords.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-neutral-300/70 p-12 text-center dark:border-neutral-700">
                <Lightbulb className="mb-4 h-10 w-10 text-neutral-400" />
                <p className="text-lg font-medium text-neutral-700 dark:text-neutral-200">
                  Gere uma lista para começar a explorar oportunidades.
                </p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  Assim que o copiloto retornar, você pode filtrar e selecionar
                  o que faz sentido.
                </p>
              </div>
            ) : (
              <div className="rounded-3xl border border-neutral-200/80 bg-white/80 shadow-inner dark:border-white/10 dark:bg-neutral-950/40">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200/80 px-6 py-4 text-sm text-neutral-500 dark:border-white/10">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={
                        selectedKeywordIds.size === keywords.length &&
                        keywords.length > 0
                      }
                      onCheckedChange={toggleAllKeywords}
                      aria-label="Selecionar todas as keywords"
                    />
                    <span>
                      {selectedKeywords.length} selecionadas / {keywords.length}{" "}
                      resultados
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-full text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                      type="button"
                      onClick={toggleSortOrder}
                      disabled={keywords.length === 0}
                    >
                      Ordenar por volume
                      <ArrowDownWideNarrow
                        className={`ml-2 h-4 w-4 transition ${
                          sortOrder === "asc" ? "rotate-180" : ""
                        }`}
                      />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="rounded-full"
                      onClick={handleGenerateTitles}
                      disabled={loading.titles || selectedKeywords.length === 0}
                    >
                      {loading.titles ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Gerando títulos...
                        </>
                      ) : (
                        <>
                          Gerar títulos
                          <NotebookPen className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                <ScrollArea className="h-[360px]">
                  <Table>
                    <TableHeader>
                      <TableRow className="text-xs uppercase tracking-wide text-neutral-500">
                        <TableHead className="w-14"></TableHead>
                        <TableHead>Keyword</TableHead>
                        <TableHead className="text-right">Volume</TableHead>
                        <TableHead className="text-right">CPC</TableHead>
                        <TableHead className="text-right">Dificuldade</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orderedKeywords.map((keyword) => (
                        <TableRow
                          key={keyword.id}
                          className="cursor-pointer text-sm transition hover:bg-neutral-100/80 dark:hover:bg-neutral-800/50"
                          onClick={() => toggleKeyword(keyword.id)}
                        >
                          <TableCell className="w-14">
                            <Checkbox
                              checked={selectedKeywordIds.has(keyword.id)}
                              onCheckedChange={() => toggleKeyword(keyword.id)}
                              aria-label={`Selecionar ${keyword.phrase}`}
                              onClick={(event) => event.stopPropagation()}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="flex flex-col gap-2">
                              <span>{keyword.phrase}</span>
                              {selectedKeywordIds.has(keyword.id) && (
                                <Textarea
                                  value={keywordBriefings[keyword.id] ?? ""}
                                  onChange={(event) =>
                                    setKeywordBriefings((prev) => ({
                                      ...prev,
                                      [keyword.id]: event.target.value,
                                    }))
                                  }
                                  placeholder="Briefing opcional para este título (tom, CTA, público...)"
                                  className="min-h-[70px] bg-white/80 text-sm text-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-200"
                                  onClick={(event) => event.stopPropagation()}
                                />
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {keyword.volume.toLocaleString("pt-BR")}
                          </TableCell>
                          <TableCell className="text-right">
                            R$ {keyword.cpc.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex flex-col items-end gap-1">
                              <Badge
                                variant="outline"
                                className="rounded-full px-2 py-0 text-[11px] font-medium uppercase tracking-wide"
                              >
                                {keyword.difficultyLabel ?? "Sem dado"}
                              </Badge>
                              {keyword.difficulty > 0 && (
                                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                                  Score {Math.round(keyword.difficulty)}
                                </span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-2xl">Propostas de título</CardTitle>
              <CardDescription className="text-base">
                Clique para definir o título favorito e ir direto para o artigo.
              </CardDescription>
            </div>
            <Badge variant="outline" className="rounded-full px-4 py-1 text-sm">
              {titles.length
                ? `${titles.length} sugestões`
                : "Aguardando keywords selecionadas"}
            </Badge>
          </CardHeader>
          <CardContent>
            {titles.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-neutral-300/70 p-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                Selecione keywords e clique em “Gerar títulos” para ver ideias
                aqui.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {titles.map((title) => {
                  const isActive = title.id === selectedTitleId;
                  return (
                    <button
                      key={title.id}
                      type="button"
                      className={`rounded-3xl border px-5 py-5 text-left transition ${
                        isActive
                          ? "border-neutral-900 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                          : "border-neutral-200/80 bg-white/70 hover:border-neutral-400 dark:border-white/10 dark:bg-neutral-950/40"
                        }`}
                      onClick={() => setSelectedTitleId(title.id)}
                    >
                      <div className="flex items-center gap-3 text-xs uppercase tracking-wide">
                        <NotebookPen className="h-4 w-4" />
                        <span>
                          {title.mood ? `${title.mood} • ` : ""}
                          {title.keywords.slice(0, 2).join(", ")}
                        </span>
                      </div>
                      <p className="mt-3 text-lg font-semibold">{title.text}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-2xl">Redação assistida</CardTitle>
              <CardDescription className="text-base">
                Ajuste o briefing, escolha a keyword principal e deixe o copiloto
                gerar o artigo completo.
              </CardDescription>
            </div>
            {selectedTitle && (
              <Badge className="rounded-full px-4 py-1 text-sm">
                Baseado em “{selectedTitle.text.slice(0, 32)}
                {selectedTitle.text.length > 32 ? "..." : ""}”
              </Badge>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">
                    Keyword principal do artigo
                  </p>
                  {selectedKeywords.length === 0 ? (
                    <p className="text-sm text-neutral-500">
                      Selecione keywords acima para habilitar a redação.
                    </p>
                  ) : (
                    <Select
                      value={articleKeywordId ?? undefined}
                      onValueChange={(value) => setArticleKeywordId(value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Escolha a keyword" />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedKeywords.map((item) => (
                          <SelectItem key={`article-keyword-${item.id}`} value={item.id}>
                            {item.phrase}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-dashed border-neutral-200/80 px-4 py-3 text-sm text-neutral-600 dark:border-white/10 dark:text-neutral-300">
                  <span>Incluir pesquisa extra</span>
                  <Switch checked={useResearch} onCheckedChange={(checked) => setUseResearch(Boolean(checked))} />
                </div>
                {useResearch && (
                  <Textarea
                    value={researchInstructions}
                    onChange={(event) => setResearchInstructions(event.target.value)}
                    placeholder="Dê instruções sobre como usar a pesquisa. Ex.: foque em ROI, cite fontes específicas..."
                    className="min-h-[120px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                  />
                )}
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">
                    Categorias (opcional)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ARTICLE_CATEGORIES.map((category) => (
                      <label
                        key={category.id}
                        className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition ${selectedCategories.includes(category.id) ? "border-neutral-900 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "border-neutral-200/80 bg-white/80 dark:border-white/10 dark:bg-neutral-900"}`}
                      >
                        <Checkbox
                          checked={selectedCategories.includes(category.id)}
                          onCheckedChange={(checked) => {
                            setSelectedCategories((prev) => {
                              const next = new Set(prev);
                              if (checked) {
                                next.add(category.id);
                              } else {
                                next.delete(category.id);
                              }
                              return Array.from(next);
                            });
                          }}
                        />
                        <span>{category.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <Textarea
                  value={customInstructions}
                  onChange={(event) => setCustomInstructions(event.target.value)}
                  placeholder="Adicione notas importantes, CTA, personas, tamanho ideal..."
                  className="min-h-[150px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                />
                <Button
                  className="w-full rounded-2xl bg-neutral-900 py-6 text-base font-medium hover:bg-neutral-800 dark:bg-white dark:text-neutral-900"
                  onClick={handleGenerateArticle}
                  disabled={
                    loading.content ||
                    !selectedTitle ||
                    !articleKeywordId ||
                    selectedKeywords.length === 0
                  }
                >
                  {loading.content ? (
                    <>
                      <Loader2 className="mr-3 h-5 w-5 animate-spin" />
                      Gerando artigo...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-3 h-5 w-5" />
                      Gerar artigo completo
                    </>
                  )}
                </Button>
              </div>
              <div className="rounded-3xl border border-neutral-200/80 bg-neutral-50/70 p-5 dark:border-white/10 dark:bg-neutral-950/40">
                <div className="mb-4 flex items-center gap-2 text-sm font-medium text-neutral-500 dark:text-neutral-300">
                  <FileText className="h-4 w-4" />
                  Prévia do artigo
                </div>
                {articleContent ? (
                  <div className="space-y-4 text-sm text-neutral-700 dark:text-neutral-300">
                    <p className="font-medium text-neutral-900 dark:text-white">
                      Artigo pronto! publique no WordPress:
                    </p>
                    <a
                      href={articleContent}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center text-neutral-900 underline dark:text-white"
                    >
                      {articleContent}
                    </a>
                  </div>
                ) : (
                  <p className="text-sm text-neutral-500">
                    Assim que o copiloto finalizar você verá o link para o WordPress aqui.
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
          </TabsContent>

          <TabsContent value="reverse" className="mt-8 space-y-8">
            <Card className="border-0 bg-gradient-to-br from-indigo-50 to-white shadow-sm ring-1 ring-indigo-100/50 dark:from-indigo-950/30 dark:to-neutral-900 dark:ring-indigo-900/30">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="rounded-full px-3 py-1 text-xs border-indigo-300 text-indigo-700 dark:border-indigo-700 dark:text-indigo-300">
                    Busca Reversa
                  </Badge>
                </div>
                <CardTitle className="text-2xl">Já tem um título? Vamos encontrar keywords</CardTitle>
                <CardDescription className="text-base">
                  Digite o título que você já tem em mente e deixe o copiloto buscar keywords relacionadas para otimizar seu conteúdo.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <Textarea
                  value={reverseSearchTitle}
                  onChange={(e) => setReverseSearchTitle(e.target.value)}
                  placeholder="Ex.: Como aumentar conversões em e-commerce com IA..."
                  className="min-h-[120px] resize-none bg-neutral-50/70 text-base dark:bg-neutral-800"
                />
                <Button
                  variant="default"
                  className="w-full rounded-2xl bg-indigo-700 px-6 py-6 text-base font-medium hover:bg-indigo-600 text-white"
                  onClick={handleReverseSearchKeywords}
                  disabled={loading.keywords || !reverseSearchTitle.trim()}
                >
                  {loading.keywords ? (
                    <>
                      <Loader2 className="mr-3 h-5 w-5 animate-spin" />
                      Buscando keywords...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-3 h-5 w-5" />
                      Buscar keywords relacionadas
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            {keywords.length > 0 && (
              <>
                <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
                  <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <CardTitle className="text-2xl">Keywords encontradas</CardTitle>
                      <CardDescription className="text-base">
                        Selecione as keywords que fazem sentido para o seu título.
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-neutral-500 dark:text-neutral-400">
                      <div className="rounded-2xl bg-neutral-100 px-4 py-2 text-center dark:bg-neutral-800">
                        <p className="text-xs uppercase">Volume médio</p>
                        <p className="text-lg font-semibold text-neutral-900 dark:text-white">
                          {keywordStats.avgVolume || "—"}
                        </p>
                      </div>
                      <div className="rounded-2xl bg-neutral-100 px-4 py-2 text-center dark:bg-neutral-800">
                        <p className="text-xs uppercase">Dificuldade média</p>
                        <p className="text-lg font-semibold text-neutral-900 dark:text-white">
                          {keywordStats.avgDifficulty || "—"}
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="rounded-3xl border border-neutral-200/80 bg-white/80 shadow-inner dark:border-white/10 dark:bg-neutral-950/40">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200/80 px-6 py-4 text-sm text-neutral-500 dark:border-white/10">
                        <div className="flex items-center gap-3">
                          <Checkbox
                            checked={
                              selectedKeywordIds.size === keywords.length &&
                              keywords.length > 0
                            }
                            onCheckedChange={toggleAllKeywords}
                            aria-label="Selecionar todas as keywords"
                          />
                          <span>
                            {selectedKeywords.length} selecionadas / {keywords.length}{" "}
                            resultados
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-full text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                          type="button"
                          onClick={toggleSortOrder}
                          disabled={keywords.length === 0}
                        >
                          Ordenar por volume
                          <ArrowDownWideNarrow
                            className={`ml-2 h-4 w-4 transition ${
                              sortOrder === "asc" ? "rotate-180" : ""
                            }`}
                          />
                        </Button>
                      </div>
                      <ScrollArea className="h-[360px]">
                        <Table>
                          <TableHeader>
                            <TableRow className="text-xs uppercase tracking-wide text-neutral-500">
                              <TableHead className="w-14"></TableHead>
                              <TableHead>Keyword</TableHead>
                              <TableHead className="text-right">Volume</TableHead>
                              <TableHead className="text-right">CPC</TableHead>
                              <TableHead className="text-right">Dificuldade</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {orderedKeywords.map((keyword) => (
                              <TableRow
                                key={keyword.id}
                                className="cursor-pointer text-sm transition hover:bg-neutral-100/80 dark:hover:bg-neutral-800/50"
                                onClick={() => toggleKeyword(keyword.id)}
                              >
                                <TableCell className="w-14">
                                  <Checkbox
                                    checked={selectedKeywordIds.has(keyword.id)}
                                    onCheckedChange={() => toggleKeyword(keyword.id)}
                                    aria-label={`Selecionar ${keyword.phrase}`}
                                    onClick={(event) => event.stopPropagation()}
                                  />
                                </TableCell>
                                <TableCell className="font-medium">{keyword.phrase}</TableCell>
                                <TableCell className="text-right">
                                  {keyword.volume.toLocaleString("pt-BR")}
                                </TableCell>
                                <TableCell className="text-right">
                                  R$ {keyword.cpc.toFixed(2)}
                                </TableCell>
                                <TableCell className="text-right">
                                  <Badge
                                    variant="outline"
                                    className="rounded-full px-2 py-0 text-[11px] font-medium uppercase tracking-wide"
                                  >
                                    {keyword.difficultyLabel ?? "Sem dado"}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-0 bg-indigo-50/50 shadow-sm ring-1 ring-indigo-200/50 dark:bg-indigo-950/20 dark:ring-indigo-900/30">
                  <CardHeader>
                    <CardTitle className="text-2xl">Próximos passos</CardTitle>
                    <CardDescription className="text-base">
                      Agora você pode gerar títulos alternativos ou ir direto para o fluxo completo.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        variant="default"
                        className="flex-1 min-w-[220px] rounded-2xl bg-indigo-700 px-6 py-6 text-base font-medium hover:bg-indigo-600 text-white"
                        onClick={() => setActiveTab("complete")}
                      >
                        Ir para fluxo completo
                        <ArrowRight className="ml-2 h-5 w-5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          <TabsContent value="manual" className="mt-8 space-y-8">
            <Card className="border-0 bg-gradient-to-br from-emerald-50 to-white shadow-sm ring-1 ring-emerald-100/50 dark:from-emerald-950/30 dark:to-neutral-900 dark:ring-emerald-900/30">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="rounded-full px-3 py-1 text-xs border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                    Modo Rápido
                  </Badge>
                </div>
                <CardTitle className="text-2xl">Keyword + Título → Artigo direto</CardTitle>
                <CardDescription className="text-base">
                  Já sabe exatamente a keyword e o título? Pule todas as etapas e vá direto para a geração do artigo.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                      Keyword Principal
                    </label>
                    <Input
                      type="text"
                      value={manualKeyword}
                      onChange={(e) => setManualKeyword(e.target.value)}
                      placeholder="Ex.: conversão e-commerce"
                      className="bg-neutral-50/70 text-base dark:bg-neutral-800"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                      Título do Artigo
                    </label>
                    <Input
                      type="text"
                      value={manualTitle}
                      onChange={(e) => setManualTitle(e.target.value)}
                      placeholder="Ex.: 10 Estratégias para Aumentar Conversão em E-commerce"
                      className="bg-neutral-50/70 text-base dark:bg-neutral-800"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {manualKeyword.trim() && manualTitle.trim() && (
              <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
                <CardHeader>
                  <CardTitle className="text-2xl">Configurações do artigo</CardTitle>
                  <CardDescription className="text-base">
                    Personalize como o artigo será gerado
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid gap-6 lg:grid-cols-2">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between rounded-2xl border border-dashed border-neutral-200/80 px-4 py-3 text-sm text-neutral-600 dark:border-white/10 dark:text-neutral-300">
                        <span>Incluir pesquisa extra</span>
                        <Switch checked={useResearch} onCheckedChange={(checked) => setUseResearch(Boolean(checked))} />
                      </div>
                      {useResearch && (
                        <Textarea
                          value={researchInstructions}
                          onChange={(event) => setResearchInstructions(event.target.value)}
                          placeholder="Dê instruções sobre como usar a pesquisa. Ex.: foque em ROI, cite fontes específicas..."
                          className="min-h-[120px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      )}
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Categorias (opcional)
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {ARTICLE_CATEGORIES.map((category) => (
                            <label
                              key={category.id}
                              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition ${selectedCategories.includes(category.id) ? "border-neutral-900 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "border-neutral-200/80 bg-white/80 dark:border-white/10 dark:bg-neutral-900"}`}
                            >
                              <Checkbox
                                checked={selectedCategories.includes(category.id)}
                                onCheckedChange={(checked) => {
                                  setSelectedCategories((prev) => {
                                    const next = new Set(prev);
                                    if (checked) {
                                      next.add(category.id);
                                    } else {
                                      next.delete(category.id);
                                    }
                                    return Array.from(next);
                                  });
                                }}
                              />
                              <span>{category.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <Textarea
                        value={customInstructions}
                        onChange={(event) => setCustomInstructions(event.target.value)}
                        placeholder="Adicione notas importantes, CTA, personas, tamanho ideal..."
                        className="min-h-[150px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                      />
                      <Button
                        className="w-full rounded-2xl bg-emerald-700 py-6 text-base font-medium hover:bg-emerald-600 text-white"
                        onClick={handleGenerateArticleManual}
                        disabled={loading.content}
                      >
                        {loading.content ? (
                          <>
                            <Loader2 className="mr-3 h-5 w-5 animate-spin" />
                            Gerando artigo...
                          </>
                        ) : (
                          <>
                            <Sparkles className="mr-3 h-5 w-5" />
                            Gerar artigo completo
                          </>
                        )}
                      </Button>
                    </div>
                    <div className="rounded-3xl border border-neutral-200/80 bg-neutral-50/70 p-5 dark:border-white/10 dark:bg-neutral-950/40">
                      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-neutral-500 dark:text-neutral-300">
                        <FileText className="h-4 w-4" />
                        Prévia do artigo
                      </div>
                      {articleContent ? (
                        <div className="space-y-4 text-sm text-neutral-700 dark:text-neutral-300">
                          <p className="font-medium text-neutral-900 dark:text-white">
                            Artigo pronto! publique no WordPress:
                          </p>
                          <a
                            href={articleContent}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center text-neutral-900 underline dark:text-white"
                          >
                            {articleContent}
                          </a>
                        </div>
                      ) : (
                        <p className="text-sm text-neutral-500">
                          Assim que o copiloto finalizar você verá o link para o WordPress aqui.
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>

        {articleTaskId && isPollingArticle && (
          <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
            <CardContent className="flex items-center gap-4 py-5 text-sm text-neutral-700 dark:text-neutral-200">
              <Loader2 className="h-5 w-5 animate-spin text-neutral-900 dark:text-white" />
              <div>
                <p className="font-semibold text-neutral-900 dark:text-white">
                  Escrevendo artigo #{articleTaskId}
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Status: {articleTaskStatus ?? "in-progress"}. Assim que o texto estiver pronto, atualizamos a prévia.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <Dialog
        open={historyDialogOpen}
        onOpenChange={(open) => {
          setHistoryDialogOpen(open);
          if (!open) {
            setHistorySelectedIds(new Set());
            setHistoryError(null);
            setHistoryLoading(false);
            setHistorySearchTerm("");
          }
        }}
      >
        <DialogContent className="w-[95vw] max-w-[90vw] sm:max-w-5xl lg:max-w-6xl border-0 bg-white/95 p-0 text-neutral-900 shadow-2xl dark:bg-neutral-900 overflow-hidden flex flex-col max-h-[90vh]">
          <DialogHeader className="space-y-3 border-b border-neutral-200/80 px-6 py-4 dark:border-white/10 flex-shrink-0">
            <DialogTitle className="text-2xl font-semibold">
              Biblioteca de keywords antigas
            </DialogTitle>
            <DialogDescription className="text-neutral-500">
              Selecione itens já salvos pelo time para gerar títulos rapidamente.
              Usaremos exatamente as keywords escolhidas no passo seguinte.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-4 flex-1 overflow-hidden flex flex-col min-h-0">
            {historyLoading && !historyLoaded ? (
              <div className="flex h-48 items-center justify-center text-neutral-500">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Buscando histórico...
              </div>
            ) : historyError ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                {historyError}
              </div>
            ) : historyKeywords.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500">
                Ainda não temos keywords salvas via Supabase.
              </div>
            ) : (
              <div className="flex flex-col gap-4 h-full min-h-0">
                <div className="flex-shrink-0">
                  <Input
                    type="text"
                    placeholder="Buscar por keyword, ideia ou idioma..."
                    value={historySearchTerm}
                    onChange={(e) => setHistorySearchTerm(e.target.value)}
                    className="w-full"
                  />
                </div>
                <div className="rounded-2xl border border-neutral-200/80 flex flex-col min-h-0 flex-1 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-neutral-200/80 bg-neutral-50/80 px-4 py-3 text-sm text-neutral-600 flex-shrink-0">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={
                          historySelectedIds.size === filteredAndOrderedHistoryKeywords.length &&
                          filteredAndOrderedHistoryKeywords.length > 0
                        }
                        onCheckedChange={toggleAllHistoryKeywords}
                        aria-label="Selecionar tudo do histórico"
                      />
                      <span>
                        {historySelectedIds.size} selecionadas / {filteredAndOrderedHistoryKeywords.length} itens
                        {historySearchTerm && ` (${historyKeywords.length} total)`}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      <Badge variant="outline" className="rounded-full px-3 py-1">
                        {historyKeywords.filter((item) => item.idea).length} ideias com contexto
                      </Badge>
                      <Badge variant="outline" className="rounded-full px-3 py-1">
                        {historyKeywords.filter((item) => item.language).length} idiomas salvos
                      </Badge>
                    </div>
                  </div>
                  <div className="flex-1 overflow-auto min-h-0">
                    <Table>
                      <TableHeader className="sticky top-0 bg-white dark:bg-neutral-900 z-10">
                        <TableRow className="text-xs uppercase tracking-wide text-neutral-500">
                          <TableHead className="w-10"></TableHead>
                          <TableHead>Keyword</TableHead>
                          <TableHead>Ideia</TableHead>
                          <TableHead>Idioma</TableHead>
                          <TableHead>País</TableHead>
                          <TableHead className="text-right">
                            <button
                              type="button"
                              onClick={() => toggleHistorySort("volume")}
                              className="flex items-center gap-1 hover:text-neutral-900 dark:hover:text-white transition w-full justify-end"
                            >
                              Volume
                              {historySortField === "volume" && (
                                <ArrowDownWideNarrow
                                  className={`h-3 w-3 transition ${
                                    historySortOrder === "asc" ? "rotate-180" : ""
                                  }`}
                                />
                              )}
                            </button>
                          </TableHead>
                          <TableHead className="text-right">
                            <button
                              type="button"
                              onClick={() => toggleHistorySort("cpc")}
                              className="flex items-center gap-1 hover:text-neutral-900 dark:hover:text-white transition w-full justify-end"
                            >
                              CPC
                              {historySortField === "cpc" && (
                                <ArrowDownWideNarrow
                                  className={`h-3 w-3 transition ${
                                    historySortOrder === "asc" ? "rotate-180" : ""
                                  }`}
                                />
                              )}
                            </button>
                          </TableHead>
                          <TableHead className="text-right">
                            <button
                              type="button"
                              onClick={() => toggleHistorySort("difficulty")}
                              className="flex items-center gap-1 hover:text-neutral-900 dark:hover:text-white transition w-full justify-end"
                            >
                              Dificuldade
                              {historySortField === "difficulty" && (
                                <ArrowDownWideNarrow
                                  className={`h-3 w-3 transition ${
                                    historySortOrder === "asc" ? "rotate-180" : ""
                                  }`}
                                />
                              )}
                            </button>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredAndOrderedHistoryKeywords.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center py-8 text-neutral-500">
                              Nenhuma keyword encontrada com esse filtro.
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredAndOrderedHistoryKeywords.map((keyword) => (
                            <TableRow
                              key={`history-${keyword.id}`}
                              className="cursor-pointer text-sm hover:bg-neutral-100/60 dark:hover:bg-neutral-800/40"
                              onClick={() => toggleHistoryKeyword(keyword.id)}
                            >
                              <TableCell>
                                <Checkbox
                                  checked={historySelectedIds.has(keyword.id)}
                                  onCheckedChange={() => toggleHistoryKeyword(keyword.id)}
                                  onClick={(event) => event.stopPropagation()}
                                  aria-label={`Selecionar ${keyword.phrase}`}
                                />
                              </TableCell>
                              <TableCell className="font-medium">{keyword.phrase}</TableCell>
                              <TableCell className="text-neutral-500">
                                {keyword.idea || "—"}
                              </TableCell>
                              <TableCell className="text-neutral-500">
                                {keyword.language?.toUpperCase() || "—"}
                              </TableCell>
                              <TableCell className="text-neutral-500">
                                {keyword.locationCode ?? "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                {keyword.volume ? keyword.volume.toLocaleString("pt-BR") : "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                {keyword.cpc ? `R$ ${keyword.cpc.toFixed(2)}` : "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                {keyword.difficultyLabel ?? "Sem dado"}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="flex flex-col gap-3 border-t border-neutral-200/80 px-6 py-4 text-sm text-neutral-500 dark:border-white/10 flex-shrink-0">
            {historyError && historyKeywords.length > 0 && (
              <p className="text-red-500">{historyError}</p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setHistorySelectedIds(new Set());
                  setHistoryDialogOpen(false);
                  setHistorySearchTerm("");
                }}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                variant="default"
                className="bg-neutral-900 hover:bg-neutral-800"
                onClick={handleApplyHistorySelection}
                disabled={historySelectedIds.size === 0}
              >
                Usar selecionadas
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && data !== null && "error" in data
        ? String((data as Record<string, unknown>).error)
        : "O copiloto não respondeu como esperado.";
    throw new Error(message);
  }

  return (data as T) ?? ({} as T);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
  });

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && data !== null && "error" in data
        ? String((data as Record<string, unknown>).error)
        : "O copiloto não respondeu como esperado.";
    throw new Error(message);
  }

  return (data as T) ?? ({} as T);
}
const ARTICLE_CATEGORIES = [
  { id: "11", label: "Agilidade" },
  { id: "336", label: "Agilidade (EN)" },
  { id: "285", label: "Changelog" },
  { id: "352", label: "Code review (EN)" },
  { id: "356", label: "Code review (PT)" },
  { id: "407", label: "Dev experience PT/EN" },
  { id: "360", label: "Dev experience (PT)" },
  { id: "374", label: "DevEx" },
  { id: "366", label: "DORA metrics (EN)" },
  { id: "378", label: "DORA metrics (PT)" },
  { id: "362", label: "Liderança" },
  { id: "305", label: "Métricas" },
  { id: "364", label: "Produtividade" },
  { id: "14", label: "Tecnologia" },
  { id: "368", label: "Engineering analytics (EN)" },
  { id: "372", label: "Leadership" },
  { id: "370", label: "Productivity (EN)" },
  { id: "321", label: "Technology (EN)" },
  { id: "419", label: "Glossary" },
  { id: "417", label: "Glossário" },
];
