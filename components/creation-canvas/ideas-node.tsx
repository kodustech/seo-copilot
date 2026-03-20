"use client";

import { memo, type PointerEvent, type WheelEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Lightbulb,
  Loader2,
  RefreshCw,
  AlertCircle,
  ExternalLink,
  Check,
} from "lucide-react";
import type { IdeaResult } from "@/lib/exa";
import type { StepStatus } from "./types";

type IdeasNodeData = {
  status: StepStatus;
  ideas?: IdeaResult[];
  selectedIds?: string[];
  error?: string;
  onToggleIdea?: (idea: IdeaResult) => void;
  onShuffleIdeas?: () => void;
};

const ANGLE_COLORS: Record<string, string> = {
  pain_points: "bg-red-500/20 text-red-300",
  questions: "bg-blue-500/20 text-blue-300",
  trends: "bg-emerald-500/20 text-emerald-300",
  comparisons: "bg-amber-500/20 text-amber-300",
  best_practices: "bg-purple-500/20 text-purple-300",
};

const SOURCE_COLORS: Record<string, string> = {
  Reddit: "bg-orange-500/20 text-orange-300",
  "dev.to": "bg-emerald-500/20 text-emerald-300",
  HackerNews: "bg-amber-500/20 text-amber-300",
  StackOverflow: "bg-yellow-500/20 text-yellow-300",
  Twitter: "bg-sky-500/20 text-sky-300",
  Medium: "bg-neutral-500/20 text-neutral-300",
  LinkedIn: "bg-blue-600/20 text-blue-300",
  "AI Research": "bg-violet-500/20 text-violet-300",
};

function stopRF(e: PointerEvent | WheelEvent) {
  e.stopPropagation();
}

function IdeasNodeComponent({ data }: NodeProps) {
  const { status, ideas, selectedIds, error, onToggleIdea, onShuffleIdeas } =
    data as unknown as IdeasNodeData;

  const selected = new Set(selectedIds ?? []);

  return (
    <div className="w-[520px] rounded-2xl border border-white/[0.08] bg-neutral-900/90 shadow-xl backdrop-blur">
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/20">
              <Lightbulb className="h-3.5 w-3.5 text-amber-400" />
            </div>
            <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
              Ideas
            </span>
            {selected.size > 0 && (
              <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-bold text-violet-300">
                {selected.size} selected
              </span>
            )}
          </div>
          {status === "done" && (
            <button
              onPointerDown={stopRF}
              onClick={() => onShuffleIdeas?.()}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-400 transition hover:bg-white/[0.08] hover:text-white"
            >
              <RefreshCw className="h-3 w-3" />
              Shuffle
            </button>
          )}
        </div>

        {/* Loading */}
        {status === "loading" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
            <span className="text-sm text-neutral-400">
              Researching ideas from communities...
            </span>
            <span className="text-xs text-neutral-600">
              Searching Reddit, dev.to, HackerNews and more
            </span>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <span className="text-sm text-red-400">{error}</span>
            <button
              onPointerDown={stopRF}
              onClick={() => onShuffleIdeas?.()}
              className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm text-white transition hover:bg-white/10"
            >
              Try again
            </button>
          </div>
        )}

        {/* Done */}
        {status === "done" && ideas && ideas.length > 0 && (
          <>
            <p className="mb-3 text-xs text-neutral-500">
              Click ideas to explore them ({ideas.length} found)
            </p>
            <div
              className="max-h-[400px] space-y-2 overflow-y-auto pr-1"
              onWheelCapture={stopRF}
              onPointerDownCapture={stopRF}
            >
              {ideas.map((idea) => {
                const isSelected = selected.has(idea.id);
                const angleColor = ANGLE_COLORS[idea.angle] ?? "bg-white/10 text-neutral-400";
                const sourceColor = SOURCE_COLORS[idea.source] ?? "bg-white/10 text-neutral-400";

                return (
                  <button
                    key={idea.id}
                    onClick={() => onToggleIdea?.(idea)}
                    className={`w-full rounded-xl p-3 text-left transition ${
                      isSelected
                        ? "bg-violet-600/20 ring-1 ring-violet-500/40"
                        : "bg-white/[0.03] hover:bg-white/[0.06]"
                    }`}
                  >
                    <div className="mb-1.5 flex items-start justify-between gap-2">
                      <h4 className="line-clamp-2 text-sm font-medium leading-snug text-white">
                        {idea.title}
                      </h4>
                      {isSelected && (
                        <Check className="h-4 w-4 shrink-0 text-violet-400" />
                      )}
                    </div>

                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sourceColor}`}>
                        {idea.source}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${angleColor}`}>
                        {idea.angleLabel}
                      </span>
                      {idea.url && (
                        <a
                          href={idea.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-neutral-600 transition hover:text-neutral-300"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>

                    {idea.summary && (
                      <p className="line-clamp-2 text-xs leading-relaxed text-neutral-500">
                        {idea.summary}
                      </p>
                    )}
                    {idea.highlights?.[0] && (
                      <p className="mt-1 line-clamp-1 text-[10px] italic text-neutral-600">
                        Inspired by: {idea.highlights[0]}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-white/20" />
    </div>
  );
}

export const IdeasNode = memo(IdeasNodeComponent);
