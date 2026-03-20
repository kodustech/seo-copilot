"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type { IdeaResult } from "@/lib/exa";
import type {
  PipelineState,
  PipelineAction,
  Branch,
  ClarifyQuestion,
  KTPair,
  OutlineData,
  ArticleData,
  SocialData,
  PipelineStepKind,
} from "./types";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);
  return token;
}

function jsonHeaders(token?: string | null) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function canvasPost(body: Record<string, unknown>, token?: string | null) {
  const res = await fetch("/api/canvas/explore", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request error.");
  return data;
}

async function pollUntilReady<T>(
  pollFn: () => Promise<{ ready: boolean } & T>,
  intervalMs: number,
  maxAttempts: number,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const result = await pollFn();
    if (result.ready) return result;
  }
  throw new Error("Timeout: operation took too long.");
}

// ---------------------------------------------------------------------------
// Reducer helpers
// ---------------------------------------------------------------------------

const INITIAL_STATE: PipelineState = {
  topic: "",
  mode: "blog",
  phase: "triage",
  trunkStatus: "idle",
  ideas: [],
  clarify: null,
  branches: [],
  stickyNotes: [],
  stickyEdges: [],
};

function mapBranch(branches: Branch[], id: string, fn: (b: Branch) => Branch): Branch[] {
  return branches.map((b) => (b.id === id ? fn(b) : b));
}

function reducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case "START_PIPELINE":
      return { ...INITIAL_STATE, topic: action.topic, mode: action.mode, phase: "triage", trunkStatus: "loading" };

    case "NEEDS_CLARIFY":
      return { ...state, phase: "clarify", trunkStatus: "done", clarify: { questions: action.questions, answers: {} } };

    case "ANSWER_QUESTION":
      if (!state.clarify) return state;
      return { ...state, clarify: { ...state.clarify, answers: { ...state.clarify.answers, [action.questionId]: action.answer } } };

    case "SUBMIT_ANSWERS":
      return { ...state, phase: "triage", trunkStatus: "loading" };

    case "SKIP_TO_IDEAS":
      return { ...state, phase: "ideas", trunkStatus: "loading", clarify: null };

    case "SET_IDEAS":
      return { ...state, phase: "ideas", trunkStatus: "done", ideas: action.ideas, trunkError: undefined, clarify: null };

    case "SET_TRUNK_ERROR":
      return { ...state, trunkStatus: "error", trunkError: action.error };

    case "SET_TRUNK_LOADING":
      return { ...state, trunkStatus: "loading", trunkError: undefined };

    // --- Branch ---
    case "ADD_BRANCH": {
      if (state.branches.some((b) => b.idea.id === action.idea.id)) return state;
      return {
        ...state,
        branches: [...state.branches, {
          id: action.idea.id,
          idea: action.idea,
          groupStatus: "loading",
          pairs: [],
          pipelines: [],
        }],
      };
    }

    case "REMOVE_BRANCH":
      return { ...state, branches: state.branches.filter((b) => b.id !== action.branchId) };

    case "SET_BRANCH_PAIRS":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b, groupStatus: "done", groupError: undefined, pairs: action.pairs,
        })),
      };

    case "SET_BRANCH_ERROR":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b, groupStatus: "error", groupError: action.error,
        })),
      };

    case "SHUFFLE_PAIR":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pairs: b.pairs.map((p, i) => i === action.pairIndex ? { ...p, id: `${p.id}-shuffling` } : p),
        })),
      };

    case "UPDATE_PAIR":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pairs: b.pairs.map((p, i) => i === action.pairIndex ? action.pair : p),
        })),
      };

    // --- Sub-pipeline ---
    case "ADVANCE_PAIR": {
      const existing = state.branches.find((b) => b.id === action.branchId);
      if (existing?.pipelines.some((p) => p.id === action.pair.id)) return state;
      const firstKind: PipelineStepKind = state.mode === "social" ? "social" : "outline";
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pipelines: [...b.pipelines, {
            id: action.pair.id,
            pair: action.pair,
            steps: [{ kind: firstKind, status: "loading" as const, data: null }],
          }],
        })),
      };
    }

    case "SET_PIPELINE_STEP_DATA":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pipelines: b.pipelines.map((p) =>
            p.id === action.pipelineId
              ? { ...p, steps: p.steps.map((s, i) => i === action.stepIndex ? { ...s, status: "done" as const, data: action.data, error: undefined } : s) }
              : p,
          ),
        })),
      };

    case "SET_PIPELINE_STEP_ERROR":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pipelines: b.pipelines.map((p) =>
            p.id === action.pipelineId
              ? { ...p, steps: p.steps.map((s, i) => i === action.stepIndex ? { ...s, status: "error" as const, error: action.error } : s) }
              : p,
          ),
        })),
      };

    case "ADD_PIPELINE_STEP":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pipelines: b.pipelines.map((p) =>
            p.id === action.pipelineId
              ? { ...p, steps: [...p.steps, { kind: action.kind, status: "loading" as const, data: null }] }
              : p,
          ),
        })),
      };

    case "SET_PIPELINE_STEP_LOADING":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pipelines: b.pipelines.map((p) =>
            p.id === action.pipelineId
              ? { ...p, steps: p.steps.map((s, i) => i === action.stepIndex ? { ...s, status: "loading" as const, data: null, error: undefined } : s) }
              : p,
          ),
        })),
      };

    case "TRUNCATE_PIPELINE":
      return {
        ...state,
        branches: mapBranch(state.branches, action.branchId, (b) => ({
          ...b,
          pipelines: b.pipelines.map((p) =>
            p.id === action.pipelineId
              ? { ...p, steps: p.steps.slice(0, action.fromStepIndex) }
              : p,
          ),
        })),
      };

    case "ADD_STICKY":
      return { ...state, stickyNotes: [...state.stickyNotes, action.note] };

    case "UPDATE_STICKY":
      return {
        ...state,
        stickyNotes: state.stickyNotes.map((n) =>
          n.id === action.noteId ? { ...n, text: action.text } : n,
        ),
      };

    case "MOVE_STICKY":
      return {
        ...state,
        stickyNotes: state.stickyNotes.map((n) =>
          n.id === action.noteId ? { ...n, position: action.position } : n,
        ),
      };

    case "DELETE_STICKY":
      return {
        ...state,
        stickyNotes: state.stickyNotes.filter((n) => n.id !== action.noteId),
        stickyEdges: state.stickyEdges.filter((e) => e.noteId !== action.noteId),
      };

    case "ADD_STICKY_EDGE": {
      const exists = state.stickyEdges.some(
        (e) => e.noteId === action.noteId && e.targetNodeId === action.targetNodeId,
      );
      if (exists) return state;
      return {
        ...state,
        stickyEdges: [...state.stickyEdges, { noteId: action.noteId, targetNodeId: action.targetNodeId }],
      };
    }

    case "DELETE_STICKY_EDGE":
      return {
        ...state,
        stickyEdges: state.stickyEdges.filter(
          (e) => !(e.noteId === action.noteId && e.targetNodeId === action.targetNodeId),
        ),
      };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Next step
// ---------------------------------------------------------------------------

const NEXT_KIND: Partial<Record<PipelineStepKind, PipelineStepKind>> = {
  outline: "article",
  article: "social",
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCreationPipeline() {
  const token = useAuthToken();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const topicRef = useRef("");

  // Keep refs in sync so callbacks always have latest values
  topicRef.current = state.topic;
  const stickyRef = useRef<typeof state.stickyNotes>([]);
  const stickyEdgeRef = useRef<typeof state.stickyEdges>([]);
  stickyRef.current = state.stickyNotes;
  stickyEdgeRef.current = state.stickyEdges;

  /** Build full context string (topic + all sticky notes with text) for AI calls */
  function buildContext(): string {
    const parts = [topicRef.current];
    const notesWithText = stickyRef.current.filter((n) => n.text.trim());
    if (notesWithText.length) {
      parts.push("User notes:\n" + notesWithText.map((n) => `- ${n.text}`).join("\n"));
    }
    return parts.join("\n\n");
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  // --- Triage ---
  const runTriage = useCallback(
    async (topic: string, answers?: Record<string, string>) => {
      try {
        // If we already have answers, skip triage and go straight to ideas
        if (answers && Object.keys(answers).length > 0) {
          const enrichedTopic = `${topic}\n\nContext from user:\n${Object.entries(answers).map(([q, a]) => `${q}: ${a}`).join("\n")}`;
          dispatch({ type: "SKIP_TO_IDEAS" });
          generateIdeas(enrichedTopic);
          return;
        }

        const result = await canvasPost({ action: "triage", topic }, token);
        if (result.needsClarification && result.questions?.length) {
          dispatch({ type: "NEEDS_CLARIFY", questions: result.questions as ClarifyQuestion[] });
        } else {
          dispatch({ type: "SKIP_TO_IDEAS" });
          generateIdeas(result.refinedTopic || topic);
        }
      } catch (err) {
        dispatch({ type: "SET_TRUNK_ERROR", error: err instanceof Error ? err.message : "Unknown error." });
      }
    },
    [token],
  );

  // --- Ideas ---
  const generateIdeas = useCallback(
    async (topic: string) => {
      try {
        const result = await canvasPost({ action: "explore-ideas", topic, context: buildContext() }, token);
        const ideas: IdeaResult[] = result.results ?? [];
        if (!ideas.length) throw new Error("No ideas found.");
        dispatch({ type: "SET_IDEAS", ideas });
      } catch (err) {
        dispatch({ type: "SET_TRUNK_ERROR", error: err instanceof Error ? err.message : "Unknown error." });
      }
    },
    [token],
  );

  // --- KT group (3 pairs) ---
  const generateKTGroup = useCallback(
    async (branchId: string, ideaTitle: string) => {
      try {
        const result = await canvasPost({ action: "keyword-title-ai", idea: ideaTitle, context: buildContext() }, token);
        const keywords = result.keywords ?? [];
        const titles = result.titles ?? [];

        // Create 3 pairs: each title matched with the keyword it targets
        const pairs: KTPair[] = titles.slice(0, 3).map((t: { id: string; text: string; keywords: string[] }, i: number) => {
          const targetKw = keywords.find((k: { phrase: string }) =>
            k.phrase.toLowerCase() === t.keywords?.[0]?.toLowerCase(),
          ) || keywords[i] || keywords[0];
          return {
            id: `${branchId}-pair-${i}`,
            keyword: targetKw,
            title: t,
          };
        });

        if (!pairs.length) throw new Error("No keyword+title combos generated.");
        dispatch({ type: "SET_BRANCH_PAIRS", branchId, pairs });
      } catch (err) {
        dispatch({ type: "SET_BRANCH_ERROR", branchId, error: err instanceof Error ? err.message : "Unknown error." });
      }
    },
    [token],
  );

  // --- Outline ---
  const generateOutline = useCallback(
    async (branchId: string, pipelineId: string, title: string, keyword: string, stepIndex: number) => {
      try {
        const result = await canvasPost({ action: "outline", title, keyword, context: buildContext() }, token);
        dispatch({ type: "SET_PIPELINE_STEP_DATA", branchId, pipelineId, stepIndex, data: { sections: result.sections } as OutlineData });
      } catch (err) {
        dispatch({ type: "SET_PIPELINE_STEP_ERROR", branchId, pipelineId, stepIndex, error: err instanceof Error ? err.message : "Unknown error." });
      }
    },
    [token],
  );

  // --- Article ---
  const generateArticle = useCallback(
    async (branchId: string, pipelineId: string, title: string, keyword: string, stepIndex: number) => {
      try {
        const { taskId } = await canvasPost({ action: "article", title, keyword, useResearch: true }, token);
        const result = await pollUntilReady(
          () => canvasPost({ action: "article_status", taskId }, token),
          5000, 80,
        );
        const articles = result.articles ?? [];
        if (!articles.length) throw new Error("No article generated.");

        dispatch({ type: "SET_PIPELINE_STEP_DATA", branchId, pipelineId, stepIndex, data: { article: articles[0] } as ArticleData });

        if (articles[0].content) {
          dispatch({ type: "ADD_PIPELINE_STEP", branchId, pipelineId, kind: "social" });
          generateSocial(branchId, pipelineId, articles[0].content, stepIndex + 1);
        }
      } catch (err) {
        dispatch({ type: "SET_PIPELINE_STEP_ERROR", branchId, pipelineId, stepIndex, error: err instanceof Error ? err.message : "Unknown error." });
      }
    },
    [token],
  );

  // --- Social ---
  const generateSocial = useCallback(
    async (branchId: string, pipelineId: string, baseContent: string, stepIndex: number) => {
      try {
        const result = await canvasPost({ action: "social", baseContent, context: buildContext() }, token);
        dispatch({ type: "SET_PIPELINE_STEP_DATA", branchId, pipelineId, stepIndex, data: { variations: result.variations ?? [] } as SocialData });
      } catch (err) {
        dispatch({ type: "SET_PIPELINE_STEP_ERROR", branchId, pipelineId, stepIndex, error: err instanceof Error ? err.message : "Unknown error." });
      }
    },
    [token],
  );

  // =========================================================================
  // Public
  // =========================================================================

  const startPipeline = useCallback((topic: string, mode: "blog" | "social") => {
    dispatch({ type: "START_PIPELINE", topic, mode });
    runTriage(topic);
  }, [runTriage]);

  const answerQuestion = useCallback((questionId: string, answer: string) => {
    dispatch({ type: "ANSWER_QUESTION", questionId, answer });
  }, []);

  const submitAnswers = useCallback(() => {
    if (!state.clarify) return;
    dispatch({ type: "SUBMIT_ANSWERS" });
    runTriage(state.topic, state.clarify.answers);
  }, [state.clarify, state.topic, runTriage]);

  const skipClarification = useCallback(() => {
    dispatch({ type: "SKIP_TO_IDEAS" });
    generateIdeas(state.topic);
  }, [state.topic, generateIdeas]);

  const toggleIdea = useCallback((idea: IdeaResult) => {
    const exists = state.branches.some((b) => b.idea.id === idea.id);
    if (exists) {
      dispatch({ type: "REMOVE_BRANCH", branchId: idea.id });
    } else {
      dispatch({ type: "ADD_BRANCH", idea });
      generateKTGroup(idea.id, idea.title);
    }
  }, [state.branches, generateKTGroup]);

  const shuffleIdeas = useCallback(() => {
    dispatch({ type: "SET_TRUNK_LOADING" });
    state.branches.forEach((b) => dispatch({ type: "REMOVE_BRANCH", branchId: b.id }));
    generateIdeas(state.topic);
  }, [state.topic, state.branches, generateIdeas]);

  const shufflePair = useCallback((branchId: string, pairIndex: number) => {
    const branch = state.branches.find((b) => b.id === branchId);
    if (!branch) return;
    dispatch({ type: "SHUFFLE_PAIR", branchId, pairIndex });
    // Re-generate just that one pair
    (async () => {
      try {
        const result = await canvasPost({ action: "keyword-title-ai", idea: branch.idea.title, context: buildContext() }, token);
        const keywords = result.keywords ?? [];
        const titles = result.titles ?? [];
        // Pick a different title than the current one
        const currentTitle = branch.pairs[pairIndex]?.title.text;
        const newTitle = titles.find((t: { text: string }) => t.text !== currentTitle) || titles[0];
        const targetKw = keywords.find((k: { phrase: string }) =>
          k.phrase.toLowerCase() === newTitle.keywords?.[0]?.toLowerCase(),
        ) || keywords[0];

        const pair: KTPair = {
          id: `${branchId}-pair-${pairIndex}-${Date.now()}`,
          keyword: targetKw,
          title: newTitle,
        };
        dispatch({ type: "UPDATE_PAIR", branchId, pairIndex, pair });
      } catch {
        // Revert shuffle state
        dispatch({ type: "UPDATE_PAIR", branchId, pairIndex, pair: branch.pairs[pairIndex] });
      }
    })();
  }, [state.branches, token]);

  const editPair = useCallback((branchId: string, pairIndex: number, field: "keyword" | "title", value: string) => {
    const branch = state.branches.find((b) => b.id === branchId);
    if (!branch) return;
    const oldPair = branch.pairs[pairIndex];
    if (!oldPair) return;

    if (field === "title") {
      // Title edit — instant, no API call
      const newPair: KTPair = {
        ...oldPair,
        title: { ...oldPair.title, text: value },
      };
      dispatch({ type: "UPDATE_PAIR", branchId, pairIndex, pair: newPair });
    } else {
      // Keyword edit — update phrase immediately, then fetch real volume
      const newPair: KTPair = {
        ...oldPair,
        keyword: { ...oldPair.keyword, phrase: value, volume: 0, difficulty: 0 },
      };
      dispatch({ type: "UPDATE_PAIR", branchId, pairIndex, pair: newPair });

      // Fetch real volume async
      (async () => {
        try {
          const vol = await canvasPost({ action: "refresh-volume", keyword: value }, token);
          const updatedPair: KTPair = {
            ...newPair,
            keyword: {
              ...newPair.keyword,
              phrase: vol.phrase ?? value,
              volume: vol.volume ?? 0,
              cpc: vol.cpc ?? 0,
              difficulty: vol.difficulty ?? 0,
            },
            estimated: vol.estimated ?? false,
          };
          dispatch({ type: "UPDATE_PAIR", branchId, pairIndex, pair: updatedPair });
        } catch {
          // Volume fetch failed — keep zero values
        }
      })();
    }
  }, [state.branches, token]);

  const advancePair = useCallback((branchId: string, pair: KTPair) => {
    dispatch({ type: "ADVANCE_PAIR", branchId, pair });

    if (state.mode === "social") {
      // Social mode: generate social posts directly from the title+keyword
      const baseContent = `Topic: ${pair.title.text}\nKeyword: ${pair.keyword.phrase}`;
      generateSocial(branchId, pair.id, baseContent, 0);
    } else {
      // Blog mode: go through outline → article → social
      generateOutline(branchId, pair.id, pair.title.text, pair.keyword.phrase, 0);
    }
  }, [state.mode, generateOutline, generateSocial]);

  const retryPipelineStep = useCallback((branchId: string, pipelineId: string, stepIndex: number) => {
    const branch = state.branches.find((b) => b.id === branchId);
    if (!branch) return;
    const pipeline = branch.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) return;
    const step = pipeline.steps[stepIndex];
    if (!step) return;

    dispatch({ type: "TRUNCATE_PIPELINE", branchId, pipelineId, fromStepIndex: stepIndex + 1 });
    dispatch({ type: "SET_PIPELINE_STEP_LOADING", branchId, pipelineId, stepIndex });

    const { title, keyword } = pipeline.pair;
    switch (step.kind) {
      case "outline":
        generateOutline(branchId, pipelineId, title.text, keyword.phrase, stepIndex);
        break;
      case "article":
        generateArticle(branchId, pipelineId, title.text, keyword.phrase, stepIndex);
        break;
      case "social": {
        const artStep = pipeline.steps.find((s) => s.kind === "article");
        const artData = artStep?.data as ArticleData | undefined;
        if (artData?.article.content) generateSocial(branchId, pipelineId, artData.article.content, stepIndex);
        break;
      }
    }
  }, [state.branches, generateOutline, generateArticle, generateSocial]);

  const advancePipelineStep = useCallback((branchId: string, pipelineId: string, stepIndex: number) => {
    const branch = state.branches.find((b) => b.id === branchId);
    if (!branch) return;
    const pipeline = branch.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) return;
    const step = pipeline.steps[stepIndex];
    if (!step || step.status !== "done") return;

    const nextKind = NEXT_KIND[step.kind];
    if (!nextKind) return;

    dispatch({ type: "ADD_PIPELINE_STEP", branchId, pipelineId, kind: nextKind });
    const newIndex = pipeline.steps.length;
    const { title, keyword } = pipeline.pair;

    switch (nextKind) {
      case "article":
        generateArticle(branchId, pipelineId, title.text, keyword.phrase, newIndex);
        break;
      case "social": {
        const artData = step.data as ArticleData;
        if (artData.article.content) generateSocial(branchId, pipelineId, artData.article.content, newIndex);
        break;
      }
    }
  }, [state.branches, generateArticle, generateSocial]);

  return {
    state,
    startPipeline,
    answerQuestion,
    submitAnswers,
    skipClarification,
    toggleIdea,
    shuffleIdeas,
    shufflePair,
    editPair,
    advancePair,
    addSticky: useCallback((position: { x: number; y: number }) => {
      const colors: Array<"amber" | "blue" | "green" | "pink"> = ["amber", "blue", "green", "pink"];
      const note = {
        id: `sticky-${Date.now()}`,
        text: "",
        position,
        color: colors[Math.floor(Math.random() * colors.length)],
      };
      dispatch({ type: "ADD_STICKY", note });
    }, []),
    updateSticky: useCallback((noteId: string, text: string) => {
      dispatch({ type: "UPDATE_STICKY", noteId, text });
    }, []),
    moveSticky: useCallback((noteId: string, position: { x: number; y: number }) => {
      dispatch({ type: "MOVE_STICKY", noteId, position });
    }, []),
    deleteSticky: useCallback((noteId: string) => {
      dispatch({ type: "DELETE_STICKY", noteId });
    }, []),
    addStickyEdge: useCallback((noteId: string, targetNodeId: string) => {
      dispatch({ type: "ADD_STICKY_EDGE", noteId, targetNodeId });
    }, []),
    retryPipelineStep,
    advancePipelineStep,
  };
}
