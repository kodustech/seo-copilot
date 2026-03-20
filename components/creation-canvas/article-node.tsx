"use client";

import { memo, type PointerEvent, type WheelEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Newspaper,
  Loader2,
  RefreshCw,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import type { ArticlePost } from "@/lib/types";
import type { StepStatus } from "./types";

type ArticleNodeData = {
  branchId: string;
  pipelineId: string;
  stepIndex: number;
  status: StepStatus;
  article?: ArticlePost;
  error?: string;
  onRetry?: (branchId: string, pipelineId: string, index: number) => void;
};

function stopRF(e: PointerEvent | WheelEvent) {
  e.stopPropagation();
}

function ArticleNodeComponent({ data }: NodeProps) {
  const { branchId, pipelineId, stepIndex, status, article, error, onRetry } =
    data as unknown as ArticleNodeData;

  return (
    <div className="w-[460px] rounded-2xl border border-white/[0.08] bg-neutral-900/90 shadow-xl backdrop-blur">
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="p-5">
        {/* Header */}
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/20">
            <Newspaper className="h-3.5 w-3.5 text-emerald-400" />
          </div>
          <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
            Article
          </span>
        </div>

        {/* Loading */}
        {status === "loading" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
            <span className="text-sm text-neutral-400">Generating article (~1-3 min)...</span>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <span className="text-sm text-red-400">{error}</span>
            <button
              onPointerDown={stopRF}
              onClick={() => onRetry?.(branchId, pipelineId, stepIndex)}
              className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm text-white transition hover:bg-white/10"
            >
              Try again
            </button>
          </div>
        )}

        {/* Done */}
        {status === "done" && article && (
          <>
            <h3 className="mb-2 text-base font-semibold text-white">{article.title}</h3>

            {article.url && (
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                onPointerDown={stopRF}
                className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/30"
              >
                <ExternalLink className="h-3 w-3" />
                View in WordPress
              </a>
            )}

            {article.content && (
              <div
                className="mb-4 max-h-[200px] overflow-y-auto rounded-xl bg-black/30 p-3"
                onWheelCapture={stopRF}
                onPointerDownCapture={stopRF}
              >
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-400">
                  {article.content.slice(0, 800)}
                  {article.content.length > 800 && "..."}
                </p>
              </div>
            )}

            {article.content && (
              <span className="mb-3 inline-block text-xs text-neutral-600">
                {article.content.split(/\s+/).length.toLocaleString()} words
              </span>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onPointerDown={stopRF}
                onClick={() => onRetry?.(branchId, pipelineId, stepIndex)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-neutral-300 transition hover:bg-white/[0.08]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Shuffle
              </button>
            </div>
          </>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-white/20" />
    </div>
  );
}

export const ArticleNode = memo(ArticleNodeComponent);
