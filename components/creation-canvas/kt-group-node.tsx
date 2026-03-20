"use client";

import { memo, useState, useRef, type PointerEvent, type WheelEvent, type KeyboardEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Key,
  Loader2,
  RefreshCw,
  ArrowRight,
  AlertCircle,
  TrendingUp,
  Gauge,
  Check,
  Pencil,
} from "lucide-react";
import type { StepStatus, KTPair, ContentMode } from "./types";

type KTGroupNodeData = {
  branchId: string;
  contentMode?: ContentMode;
  groupStatus: StepStatus;
  pairs: KTPair[];
  advancedIds: string[];
  error?: string;
  onShufflePair?: (branchId: string, pairIndex: number) => void;
  onAdvancePair?: (branchId: string, pair: KTPair) => void;
  onRetryGroup?: (branchId: string) => void;
  onEditPair?: (branchId: string, pairIndex: number, field: "keyword" | "title", value: string) => void;
};

function stopRF(e: PointerEvent | WheelEvent) {
  e.stopPropagation();
}

// ---------------------------------------------------------------------------
// Inline editable field
// ---------------------------------------------------------------------------

function EditableField({
  value,
  onCommit,
  className,
}: {
  value: string;
  onCommit: (newValue: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(value);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onCommit(trimmed);
    }
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKey}
        className="w-full rounded-lg border border-violet-500/30 bg-white/[0.06] px-2 py-1 text-sm text-white outline-none focus:ring-1 focus:ring-violet-500/40"
      />
    );
  }

  return (
    <button
      onClick={startEdit}
      className={`group/edit flex w-full items-start gap-1.5 text-left ${className ?? ""}`}
    >
      <span className="flex-1">{value}</span>
      <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-neutral-600 opacity-0 transition group-hover/edit:opacity-100" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function KTGroupNodeComponent({ data }: NodeProps) {
  const { branchId, contentMode, groupStatus, pairs, advancedIds, error, onShufflePair, onAdvancePair, onRetryGroup, onEditPair } =
    data as unknown as KTGroupNodeData;

  const advanced = new Set(advancedIds ?? []);

  return (
    <div className="w-[440px] rounded-2xl border border-white/[0.08] bg-neutral-900/90 shadow-xl backdrop-blur">
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/20">
            <Key className="h-3.5 w-3.5 text-violet-400" />
          </div>
          <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
            Keyword + Title
          </span>
        </div>

        {groupStatus === "loading" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
            <span className="text-sm text-neutral-400">Generating 3 keyword + title combos...</span>
          </div>
        )}

        {groupStatus === "error" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <span className="text-sm text-red-400">{error}</span>
            <button
              onPointerDown={stopRF}
              onClick={() => onRetryGroup?.(branchId)}
              className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm text-white transition hover:bg-white/10"
            >
              Try again
            </button>
          </div>
        )}

        {groupStatus === "done" && pairs.length > 0 && (
          <div
            className="space-y-3"
            onWheelCapture={stopRF}
            onPointerDownCapture={stopRF}
          >
            {pairs.map((pair, i) => {
              const isAdvanced = advanced.has(pair.id);
              const isShuffling = pair.id.endsWith("-shuffling");

              return (
                <div
                  key={pair.id}
                  className={`rounded-xl border p-3 transition ${
                    isAdvanced
                      ? "border-violet-500/30 bg-violet-600/10"
                      : "border-white/[0.06] bg-white/[0.03]"
                  }`}
                >
                  {isShuffling ? (
                    <div className="flex items-center justify-center gap-2 py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                      <span className="text-xs text-neutral-400">Shuffling...</span>
                    </div>
                  ) : (
                    <>
                      {/* Keyword — editable */}
                      <div className="mb-2">
                        <div className="mb-1 flex items-center gap-1.5">
                          <Key className="h-3 w-3 text-violet-400" />
                          <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
                            Keyword
                          </span>
                        </div>
                        <EditableField
                          value={pair.keyword.phrase}
                          onCommit={(v) => onEditPair?.(branchId, i, "keyword", v)}
                          className="text-sm font-medium text-white"
                        />
                        <div className="mt-1 flex items-center gap-3">
                          <span className="flex items-center gap-1 text-[11px] text-neutral-500">
                            <TrendingUp className="h-2.5 w-2.5" />
                            {pair.keyword.volume > 0 ? pair.keyword.volume.toLocaleString() : "< 10"}
                            {pair.estimated && <span className="text-[9px] text-amber-500/70">~est</span>}
                          </span>
                          <span className="flex items-center gap-1 text-[11px] text-neutral-500">
                            <Gauge className="h-2.5 w-2.5" />
                            KD: {pair.keyword.difficulty > 0 ? pair.keyword.difficulty : "—"}
                          </span>
                        </div>
                      </div>

                      {/* Title — editable */}
                      <div className="mb-3">
                        <EditableField
                          value={pair.title.text}
                          onCommit={(v) => onEditPair?.(branchId, i, "title", v)}
                          className="text-sm font-semibold leading-snug text-white"
                        />
                      </div>

                      {/* Actions */}
                      {isAdvanced ? (
                        <div className="flex items-center gap-1.5 text-xs text-violet-400">
                          <Check className="h-3 w-3" />
                          Advanced
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            onClick={() => onShufflePair?.(branchId, i)}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-white/[0.08]"
                          >
                            <RefreshCw className="h-3 w-3" />
                            Shuffle
                          </button>
                          <button
                            onClick={() => onAdvancePair?.(branchId, pair)}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-violet-500"
                          >
                            {contentMode === "social" ? "Create Social" : "Write Article"}
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-white/20" />
    </div>
  );
}

export const KTGroupNode = memo(KTGroupNodeComponent);
