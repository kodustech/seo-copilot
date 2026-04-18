"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Check, PenSquare, Sparkles, Star, Trash2 } from "lucide-react";

import type { IdeaCard } from "@/lib/ideas";

type CardState = "idle" | "saved" | "dismissed" | "promoted";

export type CardNodeData = {
  card: IdeaCard;
  state: CardState;
  onSave?: () => void;
  onDismiss?: () => void;
  onDraft?: () => void;
};

const FORMAT_BADGES: Record<IdeaCard["suggestedFormat"], string> = {
  blog: "Blog",
  linkedin: "LinkedIn",
  twitter: "X / Twitter",
  any: "Any",
};

function CardNodeComponent({ data }: NodeProps) {
  const { card, state, onSave, onDismiss, onDraft } =
    data as unknown as CardNodeData;

  const dimmed = state === "dismissed";

  return (
    <div
      className={`w-[300px] rounded-xl border bg-neutral-900/80 p-3 backdrop-blur transition ${
        dimmed
          ? "border-white/[0.04] opacity-40"
          : state === "saved"
            ? "border-amber-400/30"
            : state === "promoted"
              ? "border-emerald-400/30"
              : "border-white/[0.08] hover:border-white/20"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-white/10" />

      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300">
          {FORMAT_BADGES[card.suggestedFormat] ?? "Any"}
        </span>
        {card.source ? (
          <span className="truncate text-[10px] text-neutral-500" title={card.source.label}>
            {card.source.label}
          </span>
        ) : null}
      </div>

      <h4 className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-white">
        {card.workingTitle}
      </h4>

      <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-neutral-300">
        {card.angle}
      </p>

      <p className="mt-2 line-clamp-2 text-[10px] italic leading-snug text-neutral-500">
        Why it might work: {card.whyItWorks}
      </p>

      <div className="mt-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onSave}
          className={`flex-1 rounded px-2 py-1 text-[10px] font-medium transition ${
            state === "saved"
              ? "bg-amber-400/20 text-amber-300"
              : "bg-white/5 text-neutral-300 hover:bg-white/10 hover:text-white"
          }`}
        >
          <Star className="mr-1 inline h-3 w-3" />
          {state === "saved" ? "Saved" : "Save"}
        </button>
        <button
          type="button"
          onClick={onDraft}
          className={`flex-1 rounded px-2 py-1 text-[10px] font-medium transition ${
            state === "promoted"
              ? "bg-emerald-400/20 text-emerald-300"
              : "bg-white/5 text-neutral-300 hover:bg-white/10 hover:text-white"
          }`}
        >
          {state === "promoted" ? (
            <>
              <Check className="mr-1 inline h-3 w-3" />
              Drafting
            </>
          ) : (
            <>
              <PenSquare className="mr-1 inline h-3 w-3" />
              Draft it
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
          className="rounded p-1 text-neutral-500 transition hover:bg-white/10 hover:text-neutral-300"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export const CardNode = memo(CardNodeComponent);

// Silence unused import — kept for future structured formatting if we need it
void Sparkles;
