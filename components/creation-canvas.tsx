"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Sparkles, Search, FileText, Share2, StickyNote } from "lucide-react";

import { useCreationPipeline } from "@/components/creation-canvas/use-creation-pipeline";
import { deriveNodesAndEdges } from "@/components/creation-canvas/layout";
import { PromptNode } from "@/components/creation-canvas/prompt-node";
import { ClarifyNode } from "@/components/creation-canvas/clarify-node";
import { IdeasNode } from "@/components/creation-canvas/ideas-node";
import { KTGroupNode } from "@/components/creation-canvas/kt-group-node";
import { OutlineNode } from "@/components/creation-canvas/outline-node";
import { ArticleNode } from "@/components/creation-canvas/article-node";
import { SocialNode } from "@/components/creation-canvas/social-node";
import { StickyNoteNode } from "@/components/creation-canvas/sticky-note-node";

const nodeTypes = {
  prompt: PromptNode,
  clarify: ClarifyNode,
  ideas: IdeasNode,
  "kt-group": KTGroupNode,
  outline: OutlineNode,
  article: ArticleNode,
  social: SocialNode,
  sticky: StickyNoteNode,
};

function CreationCanvasInner() {
  const {
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
    retryPipelineStep,
    advancePipelineStep,
    addSticky,
    updateSticky,
    moveSticky,
    deleteSticky,
    addStickyEdge,
  } = useCreationPipeline();
  const { fitView, screenToFlowPosition } = useReactFlow();
  const searchParams = useSearchParams();

  const [topicInput, setTopicInput] = useState("");
  const started = !!state.topic;
  const autoStarted = useRef(false);

  useEffect(() => {
    if (autoStarted.current || started) return;
    const urlTopic = searchParams.get("topic");
    const urlMode = searchParams.get("mode") as "blog" | "social" | null;
    if (urlTopic) {
      autoStarted.current = true;
      setTopicInput(urlTopic);
      startPipeline(urlTopic, urlMode || "blog");
    }
  }, [searchParams, started, startPipeline]);

  const { nodes: rawNodes, edges } = useMemo(() => deriveNodesAndEdges(state), [state]);

  const nodes = useMemo(
    () =>
      rawNodes.map((node) => {
        const d = node.data as Record<string, unknown>;
        return {
          ...node,
          data: {
            ...d,
            contentMode: state.mode,
            // Clarify
            onAnswer: answerQuestion,
            onSubmit: submitAnswers,
            onSkip: skipClarification,
            // Ideas
            onToggleIdea: toggleIdea,
            onShuffleIdeas: shuffleIdeas,
            // KT Group
            onShufflePair: shufflePair,
            onEditPair: editPair,
            onAdvancePair: advancePair,
            // Pipeline steps
            onRetry: retryPipelineStep,
            onAdvance: advancePipelineStep,
            // Sticky
            onUpdate: updateSticky,
            onDelete: deleteSticky,
          },
        };
      }),
    [rawNodes, state.mode, answerQuestion, submitAnswers, skipClarification, toggleIdea, shuffleIdeas, shufflePair, editPair, advancePair, retryPipelineStep, advancePipelineStep, updateSticky, deleteSticky],
  );

  // Auto-fit when new nodes appear
  const nodeCount = rawNodes.length;
  const prevNodeCount = useRef(0);
  useEffect(() => {
    if (nodeCount !== prevNodeCount.current && nodeCount > prevNodeCount.current) {
      prevNodeCount.current = nodeCount;
      requestAnimationFrame(() => fitView({ padding: 0.2, duration: 400 }));
    }
    prevNodeCount.current = nodeCount;
  }, [nodeCount, fitView]);

  // Handle sticky note drag end — save position
  const onNodeDragStop = useCallback(
    (_event: unknown, node: { id: string; position: { x: number; y: number } }) => {
      if (node.id.startsWith("sticky-")) {
        moveSticky(node.id, node.position);
      }
    },
    [moveSticky],
  );

  // Handle connections — when user drags from sticky note to another node
  const onConnect: OnConnect = useCallback(
    (params) => {
      if (params.source?.startsWith("sticky-")) {
        addStickyEdge(params.source, params.target!);
      }
    },
    [addStickyEdge],
  );

  // Add sticky note at center of viewport
  const handleAddSticky = useCallback(() => {
    const pos = screenToFlowPosition({ x: window.innerWidth / 2 - 110, y: window.innerHeight / 2 });
    addSticky(pos);
  }, [screenToFlowPosition, addSticky]);

  const handleStart = useCallback(
    (mode: "blog" | "social") => {
      if (topicInput.trim()) startPipeline(topicInput.trim(), mode);
    },
    [topicInput, startPipeline],
  );

  return (
    <div className="relative h-full w-full bg-neutral-950">
      {!started && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex w-full max-w-lg flex-col items-center gap-5">
            <div className="flex items-center gap-2 text-neutral-400">
              <Sparkles className="h-5 w-5 text-violet-400" />
              <span className="text-lg font-medium text-white">Content Canvas</span>
            </div>
            <p className="text-center text-sm text-neutral-500">What do you want to create today?</p>
            <div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-neutral-900/80 px-4 py-3 backdrop-blur">
              <Search className="h-4 w-4 text-neutral-500" />
              <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder="E.g. how to implement CI/CD in Next.js"
                className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-neutral-600"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleStart("blog");
                  }
                }}
              />
            </div>
            <div className="flex w-full gap-3">
              <button
                onClick={() => handleStart("blog")}
                disabled={!topicInput.trim()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
              >
                <FileText className="h-4 w-4" />
                Blog Post
              </button>
              <button
                onClick={() => handleStart("social")}
                disabled={!topicInput.trim()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-white transition hover:bg-white/[0.1] disabled:opacity-40"
              >
                <Share2 className="h-4 w-4" />
                Social Post
              </button>
            </div>
          </div>
        </div>
      )}

      {started && (
        <>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.05}
            maxZoom={2}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(255,255,255,0.04)" />
            <Controls showInteractive={false} className="!rounded-xl !border-white/10 !bg-neutral-900/80 !shadow-xl" />
            <MiniMap className="!rounded-xl !border-white/10 !bg-neutral-900/60" maskColor="rgba(0,0,0,0.6)" nodeColor="rgba(139,92,246,0.4)" />
          </ReactFlow>

          {/* Floating add note button */}
          <button
            onClick={handleAddSticky}
            className="absolute bottom-6 right-6 z-10 flex items-center gap-2 rounded-xl border border-amber-500/20 bg-neutral-900/90 px-4 py-2.5 text-sm font-medium text-amber-400 shadow-lg backdrop-blur transition hover:bg-amber-500/10"
          >
            <StickyNote className="h-4 w-4" />
            Add Note
          </button>
        </>
      )}
    </div>
  );
}

export function CreationCanvas() {
  return (
    <ReactFlowProvider>
      <CreationCanvasInner />
    </ReactFlowProvider>
  );
}
