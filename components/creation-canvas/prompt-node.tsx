"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Pen } from "lucide-react";

function PromptNodeComponent({ data }: NodeProps) {
  const { topic } = data as unknown as { topic: string };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-600/90 to-purple-700/90 px-8 py-5 shadow-lg shadow-violet-500/10 backdrop-blur">
      <Pen className="h-5 w-5 shrink-0 text-violet-200" />
      <span className="text-lg font-semibold text-white">{topic}</span>
      <Handle type="source" position={Position.Bottom} className="!bg-violet-400" />
    </div>
  );
}

export const PromptNode = memo(PromptNodeComponent);
