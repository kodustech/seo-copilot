"use client";

import { memo, type PointerEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Key,
  FileText,
  Loader2,
  RefreshCw,
  ArrowRight,
  AlertCircle,
  TrendingUp,
  Gauge,
} from "lucide-react";
import type { KeywordSuggestion, TitleIdea } from "@/lib/types";
import type { StepStatus } from "./types";

type KTNodeData = {
  branchId: string;
  stepIndex: number;
  status: StepStatus;
  keyword?: KeywordSuggestion;
  title?: TitleIdea;
  error?: string;
  onRetry?: (branchId: string, index: number) => void;
  onAdvance?: (branchId: string, index: number) => void;
};

function stopRF(e: PointerEvent) {
  e.stopPropagation();
}

function KeywordTitleNodeComponent({ data }: NodeProps) {
  const { branchId, stepIndex, status, keyword, title, error, onRetry, onAdvance } =
    data as unknown as KTNodeData;

  return (
    <div className="w-[420px] rounded-2xl border border-white/[0.08] bg-neutral-900/90 shadow-xl backdrop-blur">
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="p-5">
        {/* Header */}
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/20">
            <Key className="h-3.5 w-3.5 text-violet-400" />
          </div>
          <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
            Keyword + Title
          </span>
        </div>

        {/* Loading */}
        {status === "loading" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
            <span className="text-sm text-neutral-400">Generating keyword and title...</span>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <span className="text-sm text-red-400">{error}</span>
            <button
              onPointerDown={stopRF}
              onClick={() => onRetry?.(branchId, stepIndex)}
              className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm text-white transition hover:bg-white/10"
            >
              Try again
            </button>
          </div>
        )}

        {/* Done */}
        {status === "done" && keyword && title && (
          <>
            {/* Keyword */}
            <div className="mb-3 rounded-xl bg-white/[0.04] p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Key className="h-3 w-3 text-violet-400" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
                  Keyword
                </span>
              </div>
              <p className="text-sm font-medium text-white">{keyword.phrase}</p>
              <div className="mt-2 flex items-center gap-3">
                <span className="flex items-center gap-1 text-xs text-neutral-500">
                  <TrendingUp className="h-3 w-3" />
                  Vol: {keyword.volume > 0 ? keyword.volume.toLocaleString() : "< 10"}
                </span>
                <span className="flex items-center gap-1 text-xs text-neutral-500">
                  <Gauge className="h-3 w-3" />
                  KD: {keyword.difficulty > 0 ? keyword.difficulty : "—"}
                </span>
              </div>
            </div>

            {/* Title */}
            <div className="mb-4 rounded-xl bg-white/[0.04] p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <FileText className="h-3 w-3 text-emerald-400" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
                  Title
                </span>
              </div>
              <p className="text-sm font-semibold leading-snug text-white">{title.text}</p>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onPointerDown={stopRF}
                onClick={() => onRetry?.(branchId, stepIndex)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-neutral-300 transition hover:bg-white/[0.08]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Shuffle
              </button>
              <button
                onPointerDown={stopRF}
                onClick={() => onAdvance?.(branchId, stepIndex)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500"
              >
                Advance
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-white/20" />
    </div>
  );
}

export const KeywordTitleNode = memo(KeywordTitleNodeComponent);
