"use client";

import { memo, type PointerEvent, type WheelEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  List,
  Loader2,
  RefreshCw,
  ArrowRight,
  AlertCircle,
} from "lucide-react";
import type { OutlineSection, StepStatus } from "./types";

type OutlineNodeData = {
  branchId: string;
  pipelineId: string;
  stepIndex: number;
  status: StepStatus;
  sections?: OutlineSection[];
  error?: string;
  onRetry?: (branchId: string, pipelineId: string, index: number) => void;
  onAdvance?: (branchId: string, pipelineId: string, index: number) => void;
};

function stopRF(e: PointerEvent | WheelEvent) {
  e.stopPropagation();
}

function OutlineNodeComponent({ data }: NodeProps) {
  const { branchId, pipelineId, stepIndex, status, sections, error, onRetry, onAdvance } =
    data as unknown as OutlineNodeData;

  return (
    <div className="w-[440px] rounded-2xl border border-white/[0.08] bg-neutral-900/90 shadow-xl backdrop-blur">
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="p-5">
        {/* Header */}
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/20">
            <List className="h-3.5 w-3.5 text-blue-400" />
          </div>
          <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
            Outline
          </span>
        </div>

        {/* Loading */}
        {status === "loading" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
            <span className="text-sm text-neutral-400">Generating outline...</span>
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
        {status === "done" && sections && (
          <>
            <div
              className="mb-4 max-h-[320px] space-y-3 overflow-y-auto pr-1"
              onWheelCapture={stopRF}
              onPointerDownCapture={stopRF}
            >
              {sections.map((section, i) => (
                <div key={i} className="rounded-xl bg-white/[0.04] p-3">
                  <h4 className="mb-1.5 text-sm font-semibold text-white">
                    {section.heading}
                  </h4>
                  <ul className="space-y-1">
                    {section.bullets.map((bullet, j) => (
                      <li
                        key={j}
                        className="flex items-start gap-2 text-xs leading-relaxed text-neutral-400"
                      >
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-blue-400/60" />
                        {bullet}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

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
              <button
                onPointerDown={stopRF}
                onClick={() => onAdvance?.(branchId, pipelineId, stepIndex)}
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

export const OutlineNode = memo(OutlineNodeComponent);
