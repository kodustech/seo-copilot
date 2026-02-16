"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  HelpCircle,
  TrendingUp,
  GitCompare,
  Award,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { IdeaAngle } from "@/lib/exa";

export type AngleNodeData = {
  angle: IdeaAngle;
  label: string;
  count: number;
  expanded: boolean;
  onToggle?: () => void;
};

const ANGLE_STYLES: Record<IdeaAngle, { bg: string; border: string; text: string }> = {
  pain_points: {
    bg: "from-red-500/20 to-red-600/10",
    border: "border-red-500/30",
    text: "text-red-400",
  },
  questions: {
    bg: "from-blue-500/20 to-blue-600/10",
    border: "border-blue-500/30",
    text: "text-blue-400",
  },
  trends: {
    bg: "from-emerald-500/20 to-emerald-600/10",
    border: "border-emerald-500/30",
    text: "text-emerald-400",
  },
  comparisons: {
    bg: "from-amber-500/20 to-amber-600/10",
    border: "border-amber-500/30",
    text: "text-amber-400",
  },
  best_practices: {
    bg: "from-purple-500/20 to-purple-600/10",
    border: "border-purple-500/30",
    text: "text-purple-400",
  },
};

const ANGLE_ICONS: Record<IdeaAngle, React.ReactNode> = {
  pain_points: <AlertTriangle className="h-4 w-4" />,
  questions: <HelpCircle className="h-4 w-4" />,
  trends: <TrendingUp className="h-4 w-4" />,
  comparisons: <GitCompare className="h-4 w-4" />,
  best_practices: <Award className="h-4 w-4" />,
};

function AngleNodeComponent({ data }: NodeProps) {
  const { angle, label, count, expanded, onToggle } = data as unknown as AngleNodeData;
  const style = ANGLE_STYLES[angle];

  return (
    <div
      className={`cursor-pointer rounded-xl border bg-gradient-to-br backdrop-blur transition hover:scale-105 ${style.bg} ${style.border}`}
      onClick={onToggle}
    >
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="flex items-center gap-2 px-5 py-3">
        <span className={style.text}>{ANGLE_ICONS[angle]}</span>
        <span className="text-sm font-semibold text-white">{label}</span>
        <span className="ml-1 rounded-full bg-white/10 px-2 py-0.5 text-xs text-neutral-300">
          {count}
        </span>
        <span className="ml-auto text-neutral-500">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-white/20" />
    </div>
  );
}

export const AngleNode = memo(AngleNodeComponent);
