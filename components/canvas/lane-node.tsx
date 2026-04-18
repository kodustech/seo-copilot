"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Database,
  Flame,
  GitCompareArrows,
  Newspaper,
  Target,
} from "lucide-react";

import type { IdeaLaneKey } from "@/lib/ideas";

export type LaneNodeData = {
  lane: IdeaLaneKey;
  label: string;
  description: string;
  count: number;
  error?: string;
};

const LANE_STYLES: Record<
  IdeaLaneKey,
  { bg: string; border: string; text: string; icon: React.ReactNode }
> = {
  topic: {
    bg: "from-violet-500/20 to-violet-600/10",
    border: "border-violet-500/30",
    text: "text-violet-300",
    icon: <Target className="h-4 w-4" />,
  },
  bubble: {
    bg: "from-sky-500/20 to-sky-600/10",
    border: "border-sky-500/30",
    text: "text-sky-300",
    icon: <Newspaper className="h-4 w-4" />,
  },
  my_data: {
    bg: "from-emerald-500/20 to-emerald-600/10",
    border: "border-emerald-500/30",
    text: "text-emerald-300",
    icon: <Database className="h-4 w-4" />,
  },
  gap: {
    bg: "from-amber-500/20 to-amber-600/10",
    border: "border-amber-500/30",
    text: "text-amber-300",
    icon: <GitCompareArrows className="h-4 w-4" />,
  },
  hot_takes: {
    bg: "from-rose-500/20 to-rose-600/10",
    border: "border-rose-500/30",
    text: "text-rose-300",
    icon: <Flame className="h-4 w-4" />,
  },
};

function LaneNodeComponent({ data }: NodeProps) {
  const { lane, label, description, count, error } =
    data as unknown as LaneNodeData;
  const style = LANE_STYLES[lane];

  return (
    <div
      className={`w-[240px] rounded-xl border bg-gradient-to-br px-4 py-3 backdrop-blur ${style.bg} ${style.border}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="flex items-center gap-2 text-white">
        <span className={style.text}>{style.icon}</span>
        <span className="text-sm font-semibold">{label}</span>
        <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-neutral-200">
          {count}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-neutral-300/80">
        {description}
      </p>
      {error ? (
        <p className="mt-2 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          {error}
        </p>
      ) : null}

      <Handle type="source" position={Position.Bottom} className="!bg-white/20" />
    </div>
  );
}

export const LaneNode = memo(LaneNodeComponent);
