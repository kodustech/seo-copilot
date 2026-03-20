"use client";

import { memo, type PointerEvent, type WheelEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { HelpCircle, ArrowRight, SkipForward } from "lucide-react";
import type { ClarifyQuestion } from "./types";

type ClarifyNodeData = {
  questions: ClarifyQuestion[];
  answers: Record<string, string>;
  onAnswer?: (questionId: string, answer: string) => void;
  onSubmit?: () => void;
  onSkip?: () => void;
};

function stopRF(e: PointerEvent | WheelEvent) {
  e.stopPropagation();
}

function ClarifyNodeComponent({ data }: NodeProps) {
  const { questions, answers, onAnswer, onSubmit, onSkip } =
    data as unknown as ClarifyNodeData;

  const allAnswered = questions.every((q) => answers[q.id]);

  return (
    <div className="w-[480px] rounded-2xl border border-white/[0.08] bg-neutral-900/90 shadow-xl backdrop-blur">
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/20">
              <HelpCircle className="h-3.5 w-3.5 text-cyan-400" />
            </div>
            <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
              Quick questions
            </span>
          </div>
          <button
            onPointerDown={stopRF}
            onClick={() => onSkip?.()}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-400 transition hover:bg-white/[0.08] hover:text-white"
          >
            <SkipForward className="h-3 w-3" />
            Skip
          </button>
        </div>

        <p className="mb-4 text-sm text-neutral-400">
          Help me narrow down the best ideas for you:
        </p>

        <div
          className="space-y-4"
          onWheelCapture={stopRF}
          onPointerDownCapture={stopRF}
        >
          {questions.map((q) => (
            <div key={q.id}>
              <p className="mb-2 text-sm font-medium text-white">{q.question}</p>
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => {
                  const selected = answers[q.id] === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => onAnswer?.(q.id, opt)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        selected
                          ? "bg-violet-600 text-white"
                          : "bg-white/[0.06] text-neutral-300 hover:bg-white/[0.1]"
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <button
          onPointerDown={stopRF}
          onClick={() => onSubmit?.()}
          disabled={!allAnswered}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
        >
          Continue
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-white/20" />
    </div>
  );
}

export const ClarifyNode = memo(ClarifyNodeComponent);
