"use client";

import { useState, useRef, type PointerEvent, type WheelEvent, type KeyboardEvent } from "react";
import { MessageSquarePlus, X } from "lucide-react";

function stopRF(e: PointerEvent | WheelEvent) {
  e.stopPropagation();
}

export function NodeNote({
  nodeId,
  note,
  onSetNote,
}: {
  nodeId: string;
  note?: string;
  onSetNote?: (nodeId: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function startEdit() {
    setDraft(note ?? "");
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function commit() {
    setEditing(false);
    onSetNote?.(nodeId, draft.trim());
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
    if (e.key === "Escape") setEditing(false);
  }

  if (editing) {
    return (
      <div
        className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5"
        onPointerDownCapture={stopRF}
        onWheelCapture={stopRF}
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <MessageSquarePlus className="h-3 w-3 text-amber-400" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400/70">
            Note
          </span>
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          rows={2}
          placeholder="Add directions for the next steps... e.g. 'focus on enterprise', 'include case study'"
          className="w-full resize-none rounded bg-black/20 px-2 py-1.5 text-xs text-amber-100 outline-none placeholder:text-amber-500/30 focus:ring-1 focus:ring-amber-500/30"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10px] text-amber-500/40">Cmd+Enter to save, Esc to cancel</span>
          <button
            onPointerDown={stopRF}
            onClick={commit}
            className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300 transition hover:bg-amber-500/30"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  if (note) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
        <MessageSquarePlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
        <button
          onPointerDown={stopRF}
          onClick={startEdit}
          className="flex-1 text-left text-xs leading-relaxed text-amber-200/80"
        >
          {note}
        </button>
        <button
          onPointerDown={stopRF}
          onClick={() => onSetNote?.(nodeId, "")}
          className="shrink-0 rounded p-0.5 text-amber-500/40 transition hover:text-red-400"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      onPointerDown={stopRF}
      onClick={startEdit}
      className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs font-medium text-amber-500/60 transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-400"
    >
      <MessageSquarePlus className="h-3.5 w-3.5" />
      Add note for next steps
    </button>
  );
}
