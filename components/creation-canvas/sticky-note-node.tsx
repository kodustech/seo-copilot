"use client";

import { memo, useState, useRef, type PointerEvent, type KeyboardEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Trash2 } from "lucide-react";

type StickyColor = "amber" | "blue" | "green" | "pink";

const COLOR_MAP: Record<StickyColor, { bg: string; border: string; text: string; placeholder: string }> = {
  amber: { bg: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-100", placeholder: "placeholder:text-amber-500/30" },
  blue: { bg: "bg-blue-500/15", border: "border-blue-500/30", text: "text-blue-100", placeholder: "placeholder:text-blue-500/30" },
  green: { bg: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-100", placeholder: "placeholder:text-emerald-500/30" },
  pink: { bg: "bg-pink-500/15", border: "border-pink-500/30", text: "text-pink-100", placeholder: "placeholder:text-pink-500/30" },
};

type StickyNodeData = {
  noteId: string;
  text: string;
  color: StickyColor;
  onUpdate?: (noteId: string, text: string) => void;
  onDelete?: (noteId: string) => void;
};

function stopRF(e: PointerEvent) {
  e.stopPropagation();
}

function StickyNoteNodeComponent({ data }: NodeProps) {
  const { noteId, text, color, onUpdate, onDelete } = data as unknown as StickyNodeData;
  const [editing, setEditing] = useState(!text);
  const [draft, setDraft] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const c = COLOR_MAP[color] ?? COLOR_MAP.amber;

  function startEdit() {
    setDraft(text);
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function commit() {
    setEditing(false);
    if (draft.trim()) {
      onUpdate?.(noteId, draft.trim());
    }
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
    if (e.key === "Escape") {
      setEditing(false);
      setDraft(text);
    }
  }

  return (
    <div className={`w-[220px] rounded-xl border ${c.bg} ${c.border} shadow-lg backdrop-blur`}>
      {/* Connectable handles — drag from here to any pipeline node */}
      <Handle type="source" position={Position.Bottom} className="!h-3 !w-3 !bg-amber-400/80 !border-2 !border-amber-300/40" />
      <Handle type="source" position={Position.Right} id="right" className="!h-3 !w-3 !bg-amber-400/80 !border-2 !border-amber-300/40" />
      <Handle type="source" position={Position.Left} id="left" className="!h-3 !w-3 !bg-amber-400/80 !border-2 !border-amber-300/40" />
      <Handle type="source" position={Position.Top} id="top" className="!h-3 !w-3 !bg-amber-400/80 !border-2 !border-amber-300/40" />

      <div className="p-3">
        {/* Header with delete */}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Note
          </span>
          <button
            onPointerDown={stopRF}
            onClick={() => onDelete?.(noteId)}
            className="rounded p-0.5 text-neutral-600 transition hover:bg-red-500/20 hover:text-red-400"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>

        {editing ? (
          <div onPointerDownCapture={stopRF}>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={handleKey}
              rows={3}
              placeholder="Type your note..."
              className={`w-full resize-none bg-transparent text-xs leading-relaxed outline-none ${c.text} ${c.placeholder}`}
              autoFocus
            />
            <span className="text-[9px] text-neutral-600">Cmd+Enter to save</span>
          </div>
        ) : (
          <button
            onPointerDown={stopRF}
            onClick={startEdit}
            className={`w-full text-left text-xs leading-relaxed ${c.text}`}
          >
            {text || "Click to edit..."}
          </button>
        )}
      </div>
    </div>
  );
}

export const StickyNoteNode = memo(StickyNoteNodeComponent);
