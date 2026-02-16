"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Sparkles, Loader2, AlertCircle } from "lucide-react";

export type TopicNodeData = {
  label: string;
  status: "idle" | "loading" | "done" | "error";
  onExplore?: () => void;
};

function TopicNodeComponent({ data }: NodeProps) {
  const { label, status, onExplore } = data as unknown as TopicNodeData;

  return (
    <div className="relative flex flex-col items-center gap-3 rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-600/90 to-purple-700/90 px-8 py-6 shadow-lg shadow-violet-500/10 backdrop-blur">
      <div className="flex items-center gap-2 text-white">
        <Sparkles className="h-5 w-5" />
        <span className="text-lg font-semibold">{label}</span>
      </div>

      {status === "idle" && onExplore && (
        <button
          onClick={onExplore}
          className="rounded-full bg-white/20 px-5 py-1.5 text-sm font-medium text-white transition hover:bg-white/30"
        >
          Explorar
        </button>
      )}

      {status === "loading" && (
        <div className="flex items-center gap-2 text-violet-200">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Buscando ideias...</span>
        </div>
      )}

      {status === "done" && (
        <span className="text-xs text-violet-200/70">Clique nos ângulos abaixo</span>
      )}

      {status === "error" && (
        <div className="flex items-center gap-1.5 text-red-300">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm">Erro ao buscar</span>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!bg-violet-400" />
    </div>
  );
}

export const TopicNode = memo(TopicNodeComponent);
