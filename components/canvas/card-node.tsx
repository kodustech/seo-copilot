"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Check,
  FileText,
  KanbanSquare,
  Share2,
  Trash2,
} from "lucide-react";

import type { IdeaCard } from "@/lib/ideas";

type CardState = "idle" | "saved" | "dismissed" | "promoted";

export type CardNodeData = {
  card: IdeaCard;
  state: CardState;
  kanbanBusy?: boolean;
  onDraftBlog?: () => void;
  onDraftSocial?: () => void;
  onSendToKanban?: () => void;
  onDismiss?: () => void;
};

const FORMAT_BADGES: Record<IdeaCard["suggestedFormat"], string> = {
  blog: "Blog",
  linkedin: "LinkedIn",
  twitter: "X / Twitter",
  any: "Any",
};

function CardNodeComponent({ data }: NodeProps) {
  const {
    card,
    state,
    kanbanBusy,
    onDraftBlog,
    onDraftSocial,
    onSendToKanban,
    onDismiss,
  } = data as unknown as CardNodeData;

  const dimmed = state === "dismissed";

  return (
    <div
      className={`w-[300px] rounded-xl border bg-neutral-900/80 p-3 backdrop-blur transition ${
        dimmed
          ? "border-white/[0.04] opacity-40"
          : state === "saved"
            ? "border-sky-400/30"
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
          <span
            className="truncate text-[10px] text-neutral-500"
            title={card.source.label}
          >
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

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onClick={onDraftBlog}
          className="flex items-center justify-center gap-1 rounded bg-white/5 px-2 py-1.5 text-[10px] font-medium text-neutral-200 transition hover:bg-violet-500/20 hover:text-violet-200"
          title="Open the Content Canvas as a Blog post pre-filled with this idea"
        >
          <FileText className="h-3 w-3" />
          Blog
        </button>
        <button
          type="button"
          onClick={onDraftSocial}
          className="flex items-center justify-center gap-1 rounded bg-white/5 px-2 py-1.5 text-[10px] font-medium text-neutral-200 transition hover:bg-violet-500/20 hover:text-violet-200"
          title="Open the Content Canvas as a Social post pre-filled with this idea"
        >
          <Share2 className="h-3 w-3" />
          Social
        </button>
        <button
          type="button"
          onClick={onSendToKanban}
          disabled={kanbanBusy || state === "saved"}
          className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-medium transition ${
            state === "saved"
              ? "bg-sky-400/20 text-sky-200"
              : "bg-white/5 text-neutral-200 hover:bg-sky-500/20 hover:text-sky-200"
          } disabled:opacity-60`}
          title="Create a new Backlog card in the Kanban with this idea"
        >
          {state === "saved" ? (
            <>
              <Check className="h-3 w-3" />
              In Backlog
            </>
          ) : (
            <>
              <KanbanSquare className="h-3 w-3" />
              Backlog
            </>
          )}
        </button>
      </div>

      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
          className="rounded p-1 text-neutral-500 transition hover:bg-white/10 hover:text-red-300"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export const CardNode = memo(CardNodeComponent);
