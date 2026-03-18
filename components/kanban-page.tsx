"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  Trash2,
  X,
} from "lucide-react";

import type {
  GrowthWorkItem,
  KanbanColumn,
  WorkItemPriority,
  WorkItemType,
} from "@/lib/kanban";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  return token;
}

function authHeaders(token?: string | null) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function typeLabel(t: WorkItemType) {
  const m: Record<WorkItemType, string> = {
    idea: "Idea",
    keyword: "Keyword",
    title: "Title",
    article: "Article",
    social: "Social",
  };
  return m[t] ?? t;
}

function priorityLabel(p: WorkItemPriority) {
  const m: Record<WorkItemPriority, string> = { high: "High", medium: "Medium", low: "Low" };
  return m[p] ?? p;
}

function priorityBadgeClass(p: WorkItemPriority) {
  if (p === "high") return "border-red-500/40 bg-red-500/10 text-red-200";
  if (p === "low") return "border-neutral-600 bg-neutral-800 text-neutral-300";
  return "border-sky-500/40 bg-sky-500/10 text-sky-200";
}

function typeBadgeClass(t: WorkItemType) {
  if (t === "article") return "border-blue-500/40 bg-blue-500/10 text-blue-200";
  if (t === "social") return "border-cyan-500/40 bg-cyan-500/10 text-cyan-200";
  if (t === "title") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (t === "keyword") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-neutral-500/40 bg-neutral-500/10 text-neutral-200";
}

function creatorInitials(email: string) {
  const name = email.split("@")[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Sortable Card
// ---------------------------------------------------------------------------

function SortableCard({
  item,
  overlay,
}: {
  item: GrowthWorkItem;
  overlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, data: { type: "card", item } });

  const style = overlay
    ? undefined
    : {
        transform: CSS.Transform.toString(transform),
        transition,
      };

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      style={style}
      className={cn(
        "group space-y-2 rounded-lg border border-white/10 bg-neutral-950 p-3",
        isDragging && "opacity-40",
        overlay && "rotate-2 shadow-2xl ring-2 ring-sky-500/50",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          className="mt-0.5 shrink-0 cursor-grab text-neutral-600 hover:text-neutral-300 active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <p className="line-clamp-2 min-w-0 flex-1 text-pretty text-sm font-medium text-neutral-100">
          {item.title}
        </p>
      </div>

      {item.description && (
        <p className="line-clamp-2 pl-6 text-pretty text-xs text-neutral-400">
          {item.description}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        <Badge variant="outline" className={cn("text-[10px]", typeBadgeClass(item.itemType))}>
          {typeLabel(item.itemType)}
        </Badge>
        <Badge variant="outline" className={cn("text-[10px]", priorityBadgeClass(item.priority))}>
          {priorityLabel(item.priority)}
        </Badge>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-neutral-500" title={item.userEmail}>
          <span className="flex size-5 items-center justify-center rounded-full bg-white/10 text-[9px] font-semibold text-neutral-300">
            {creatorInitials(item.userEmail)}
          </span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column header
// ---------------------------------------------------------------------------

function ColumnHeader({
  column,
  count,
  onRename,
  onDelete,
}: {
  column: KanbanColumn;
  count: number;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(column.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commitRename() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== column.name) onRename(trimmed);
    else setName(column.name);
    setEditing(false);
  }

  return (
    <div className="flex items-center gap-2 px-1 pb-3">
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            commitRename();
          }}
        >
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            className="h-7 bg-neutral-900 text-sm"
          />
        </form>
      ) : (
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-200">
          {column.name}
        </h3>
      )}
      <Badge
        variant="outline"
        className="tabular-nums border-white/15 bg-white/5 text-neutral-400"
      >
        {count}
      </Badge>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="size-7 p-0 text-neutral-500 hover:text-neutral-200">
            <MoreHorizontal className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-36 border-white/10 bg-neutral-950 p-1 text-neutral-100"
        >
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-xs text-neutral-300 hover:bg-white/10 hover:text-white"
            onClick={() => setEditing(true)}
          >
            <Pencil className="mr-2 size-3" />
            Rename
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
            onClick={onDelete}
          >
            <Trash2 className="mr-2 size-3" />
            Delete
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add column form
// ---------------------------------------------------------------------------

function AddColumnForm({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setName("");
    setOpen(false);
  }

  if (!open) {
    return (
      <div className="flex w-[300px] shrink-0 items-start pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="text-neutral-500 hover:text-neutral-200"
          onClick={() => setOpen(true)}
        >
          <Plus className="mr-1.5 size-4" />
          Add column
        </Button>
      </div>
    );
  }

  return (
    <div className="w-[300px] shrink-0 space-y-2 rounded-lg border border-white/10 bg-neutral-900/50 p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Column name..."
          className="h-8 bg-neutral-950 text-sm"
        />
        <div className="mt-2 flex gap-2">
          <Button type="submit" size="sm" className="bg-white text-neutral-900 hover:bg-neutral-200">
            Add
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-neutral-400"
            onClick={() => {
              setOpen(false);
              setName("");
            }}
          >
            <X className="size-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick add card
// ---------------------------------------------------------------------------

function QuickAddCard({
  onAdd,
  loading,
}: {
  onAdd: (title: string) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  if (!open) {
    return (
      <button
        className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-white/10 px-3 py-2 text-xs text-neutral-500 transition hover:border-white/20 hover:text-neutral-300"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" />
        Add card
      </button>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = title.trim();
        if (!trimmed) return;
        onAdd(trimmed);
        setTitle("");
        setOpen(false);
      }}
    >
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Card title..."
        className="h-8 bg-neutral-900 text-sm"
        disabled={loading}
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          className="bg-white text-neutral-900 hover:bg-neutral-200"
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : "Add"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-neutral-400"
          onClick={() => {
            setOpen(false);
            setTitle("");
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main Kanban Page
// ---------------------------------------------------------------------------

export function KanbanPage() {
  const token = useAuthToken();
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [items, setItems] = useState<GrowthWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingCardCol, setAddingCardCol] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<GrowthWorkItem | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // ---- Data fetching ----

  const loadBoard = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/kanban/items", {
        headers: authHeaders(token),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load board.");
      setItems(Array.isArray(data.items) ? data.items : []);
      setColumns(Array.isArray(data.columns) ? data.columns : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load board.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  // ---- Group items by column ----

  const itemsByColumn = useMemo(() => {
    const map = new Map<string, GrowthWorkItem[]>();
    for (const col of columns) map.set(col.id, []);

    for (const item of items) {
      const colId = item.columnId;
      if (colId && map.has(colId)) {
        map.get(colId)!.push(item);
      } else if (columns.length > 0) {
        // Fallback: put in first column
        map.get(columns[0].id)!.push(item);
      }
    }

    // Sort by position within each column
    for (const [, list] of map) {
      list.sort((a, b) => a.position - b.position);
    }

    return map;
  }, [columns, items]);

  // ---- Column CRUD ----

  async function handleAddColumn(name: string) {
    if (!token) return;
    try {
      const res = await fetch("/api/kanban/columns", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setColumns((prev) => [...prev, data.column]);
    } catch {
      // Silently fail — user can retry
    }
  }

  async function handleRenameColumn(colId: string, name: string) {
    if (!token) return;
    setColumns((prev) =>
      prev.map((c) => (c.id === colId ? { ...c, name } : c)),
    );
    await fetch(`/api/kanban/columns/${colId}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    });
  }

  async function handleDeleteColumn(colId: string) {
    if (!token) return;
    const col = columns.find((c) => c.id === colId);
    if (!col) return;
    if (!window.confirm(`Delete column "${col.name}"? Cards will move to the first column.`)) return;

    setColumns((prev) => prev.filter((c) => c.id !== colId));
    // Move items locally to first column
    const fallback = columns.find((c) => c.id !== colId);
    if (fallback) {
      setItems((prev) =>
        prev.map((i) => (i.columnId === colId ? { ...i, columnId: fallback.id } : i)),
      );
    }

    await fetch(`/api/kanban/columns/${colId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
  }

  // ---- Card CRUD ----

  async function handleAddCard(columnId: string, title: string) {
    if (!token) return;
    setAddingCardCol(columnId);
    try {
      const col = columns.find((c) => c.id === columnId);
      const res = await fetch("/api/kanban/items", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          title,
          columnId,
          stage: col?.slug ?? "backlog",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems((prev) => [data.item, ...prev]);
    } catch {
      // Silently fail
    } finally {
      setAddingCardCol(null);
    }
  }

  // ---- Drag and Drop ----

  function handleDragStart(event: DragStartEvent) {
    const item = items.find((i) => i.id === event.active.id);
    setActiveItem(item ?? null);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Find source and destination columns
    const activeItem = items.find((i) => i.id === activeId);
    if (!activeItem) return;

    const sourceColId = activeItem.columnId;

    // Is the over target a column or a card?
    const isOverColumn = columns.some((c) => c.id === overId);
    const destColId = isOverColumn
      ? overId
      : items.find((i) => i.id === overId)?.columnId;

    if (!destColId || sourceColId === destColId) return;

    // Move to new column optimistically
    setItems((prev) =>
      prev.map((i) =>
        i.id === activeId ? { ...i, columnId: destColId } : i,
      ),
    );
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveItem(null);
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const item = items.find((i) => i.id === activeId);
    if (!item) return;

    const overId = over.id as string;
    const isOverColumn = columns.some((c) => c.id === overId);
    const destColId = isOverColumn
      ? overId
      : items.find((i) => i.id === overId)?.columnId ?? item.columnId;

    if (!destColId || !token) return;

    // Find column slug for stage sync
    const destCol = columns.find((c) => c.id === destColId);

    // Persist
    await fetch(`/api/kanban/items/${activeId}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({
        columnId: destColId,
        stage: destCol?.slug ?? undefined,
      }),
    });
  }

  // ---- Render ----

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-8 animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-neutral-400">
        <p className="text-sm">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadBoard()}
          className="border-white/10 text-neutral-300"
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 px-4 py-6 text-neutral-100 sm:px-6">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Kanban</h1>
            <p className="mt-0.5 text-sm text-neutral-500">
              Shared board — all team members see every card.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-white/15 bg-transparent text-neutral-300 hover:bg-white/10"
            onClick={() => void loadBoard()}
          >
            <RefreshCcw className="mr-1.5 size-4" />
            Refresh
          </Button>
        </header>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto pb-4">
            {columns.map((col) => {
              const colItems = itemsByColumn.get(col.id) ?? [];
              return (
                <div
                  key={col.id}
                  className="w-[300px] shrink-0 rounded-lg border border-white/10 bg-neutral-900/50 p-3"
                >
                  <ColumnHeader
                    column={col}
                    count={colItems.length}
                    onRename={(name) => handleRenameColumn(col.id, name)}
                    onDelete={() => handleDeleteColumn(col.id)}
                  />

                  <SortableContext
                    id={col.id}
                    items={colItems.map((i) => i.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="flex min-h-[80px] flex-col gap-2">
                      {colItems.map((item) => (
                        <SortableCard key={item.id} item={item} />
                      ))}
                    </div>
                  </SortableContext>

                  <div className="mt-3">
                    <QuickAddCard
                      onAdd={(title) => handleAddCard(col.id, title)}
                      loading={addingCardCol === col.id}
                    />
                  </div>
                </div>
              );
            })}

            <AddColumnForm onAdd={handleAddColumn} />
          </div>

          <DragOverlay>
            {activeItem ? <SortableCard item={activeItem} overlay /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
