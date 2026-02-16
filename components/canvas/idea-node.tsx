"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Star, ExternalLink } from "lucide-react";
import type { IdeaAngle } from "@/lib/exa";

export type IdeaNodeData = {
  ideaId: string;
  title: string;
  source: string;
  summary: string | null;
  url: string;
  angle: IdeaAngle;
  favorited: boolean;
  onSelect?: () => void;
  onToggleFavorite?: () => void;
};

const SOURCE_COLORS: Record<string, string> = {
  Reddit: "bg-orange-500/20 text-orange-300",
  "dev.to": "bg-emerald-500/20 text-emerald-300",
  HackerNews: "bg-amber-500/20 text-amber-300",
  StackOverflow: "bg-yellow-500/20 text-yellow-300",
  Twitter: "bg-sky-500/20 text-sky-300",
  Medium: "bg-neutral-500/20 text-neutral-300",
  Hashnode: "bg-blue-500/20 text-blue-300",
  LinkedIn: "bg-blue-600/20 text-blue-300",
};

function IdeaNodeComponent({ data }: NodeProps) {
  const { title, source, summary, url, favorited, onSelect, onToggleFavorite } =
    data as unknown as IdeaNodeData;

  const sourceColor = SOURCE_COLORS[source] ?? "bg-white/10 text-neutral-400";

  return (
    <div
      className="group w-[260px] cursor-pointer rounded-xl border border-white/[0.06] bg-neutral-900/80 backdrop-blur transition hover:border-white/10 hover:bg-neutral-800/80"
      onClick={onSelect}
    >
      <Handle type="target" position={Position.Top} className="!bg-white/10" />

      <div className="p-4">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h4 className="line-clamp-2 text-sm font-medium leading-snug text-white">
            {title}
          </h4>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite?.();
            }}
            className="shrink-0 p-0.5 transition hover:scale-110"
          >
            <Star
              className={`h-4 w-4 ${
                favorited
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-neutral-600 group-hover:text-neutral-400"
              }`}
            />
          </button>
        </div>

        <div className="mb-2 flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sourceColor}`}>
            {source}
          </span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-neutral-600 transition hover:text-neutral-300"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {summary && (
          <p className="line-clamp-3 text-xs leading-relaxed text-neutral-400">
            {summary}
          </p>
        )}
      </div>
    </div>
  );
}

export const IdeaNode = memo(IdeaNodeComponent);
