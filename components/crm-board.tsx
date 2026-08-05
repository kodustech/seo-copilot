"use client";

// ---------------------------------------------------------------------------
// Kanban view of the accounts list.
//
// The list answers "what is in the CRM"; the board answers "what do I do next".
// Same data, same filters — only the arrangement differs, so this takes the
// companies the page already loaded rather than fetching its own.
//
// Which field becomes the columns is a choice, not a constant, because the CRM
// carries two ladders and a board can only show one:
//
//   prep    not started → enriched → ready | parked   (the work you do)
//   status  lead → engaged → ... → customer           (where the deal stands)
//
// They are genuinely independent, not two halves of one line: an account can be
// a self-serve `customer` while its prep is still `not_started`, because it
// bought without anyone ever enriching or contacting it. Two of those exist
// today. So the board asks which question you are answering and groups by that.
//
// Tier is offered read-only. It is not a ladder you walk an account through —
// the sweep decides it from product behaviour, and dragging a card from t2 to
// t0 would be asserting something about the account that is not ours to assert.
// ---------------------------------------------------------------------------

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useDraggable } from "@dnd-kit/core";
import { useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  COMPANY_STATUSES,
  COMPANY_PREP_VALUES,
  type CompanyWithIdle,
} from "@/lib/crm";

export type BoardGroupBy = "prep" | "status" | "tier";

/** Columns for one grouping, in the order they should read left to right. */
type ColumnDef = { id: string; label: string; hint?: string; className: string };

const NO_TIER = "__none__";

export function boardColumns(
  groupBy: BoardGroupBy,
  labels: {
    prep: Record<string, { label: string; className: string; hint: string }>;
    status: Record<string, { label: string; className: string }>;
    tier: Record<string, { label: string; className: string; hint: string }>;
  },
): ColumnDef[] {
  if (groupBy === "prep") {
    return COMPANY_PREP_VALUES.map((p) => ({
      id: p,
      label: labels.prep[p].label,
      hint: labels.prep[p].hint,
      className: labels.prep[p].className,
    }));
  }
  if (groupBy === "status") {
    return COMPANY_STATUSES.map((s) => ({
      id: s,
      label: labels.status[s].label,
      className: labels.status[s].className,
    }));
  }
  return [
    ...["t0", "t1", "t2", "t3", "customer"].map((t) => ({
      id: t,
      label: labels.tier[t].label,
      hint: labels.tier[t].hint,
      className: labels.tier[t].className,
    })),
    // Accounts the sweep never classified still have to appear somewhere, or
    // the board silently holds fewer accounts than the list does.
    {
      id: NO_TIER,
      label: "No tier",
      hint: "Not classified by the sweep — manual or research-sourced",
      className: "bg-neutral-800/60 text-neutral-500",
    },
  ];
}

function columnOf(company: CompanyWithIdle, groupBy: BoardGroupBy): string {
  if (groupBy === "prep") return company.prepStatus;
  if (groupBy === "status") return company.status;
  return company.tier ?? NO_TIER;
}

export function CrmBoard({
  companies,
  groupBy,
  columns,
  onMove,
  onOpen,
  renderCardMeta,
}: {
  companies: CompanyWithIdle[];
  groupBy: BoardGroupBy;
  columns: ColumnDef[];
  /** Called with the field patch for the new column. Null when the grouping is
   *  read-only, which is what disables dragging. */
  onMove: ((id: string, patch: Record<string, unknown>) => void) | null;
  onOpen: (company: CompanyWithIdle) => void;
  renderCardMeta: (company: CompanyWithIdle) => React.ReactNode;
}) {
  const [dragging, setDragging] = useState<CompanyWithIdle | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const byColumn = useMemo(() => {
    const map = new Map<string, CompanyWithIdle[]>();
    for (const col of columns) map.set(col.id, []);
    for (const c of companies) {
      const key = columnOf(c, groupBy);
      // A value with no column (a status added to the DB but not to the UI)
      // would otherwise vanish from the board without a trace.
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return map;
  }, [companies, columns, groupBy]);

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    if (!onMove) return;
    const id = String(event.active.id);
    const target = event.over ? String(event.over.id) : null;
    if (!target) return;
    const company = companies.find((c) => c.id === id);
    if (!company || columnOf(company, groupBy) === target) return;
    if (groupBy === "prep") onMove(id, { prepStatus: target });
    else if (groupBy === "status") onMove(id, { status: target });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e: DragStartEvent) =>
        setDragging(companies.find((c) => c.id === String(e.active.id)) ?? null)
      }
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((col) => {
          const items = byColumn.get(col.id) ?? [];
          return (
            <BoardColumn
              key={col.id}
              def={col}
              count={items.length}
              draggable={Boolean(onMove)}
            >
              {items.map((c) => (
                <BoardCard
                  key={c.id}
                  company={c}
                  draggable={Boolean(onMove)}
                  onOpen={() => onOpen(c)}
                  meta={renderCardMeta(c)}
                />
              ))}
              {items.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-neutral-700">
                  Empty
                </p>
              ) : null}
            </BoardColumn>
          );
        })}
      </div>

      <DragOverlay>
        {dragging ? (
          <div className="w-64 rotate-2 rounded-md border border-white/20 bg-neutral-900 p-2.5 shadow-xl">
            <p className="truncate text-sm text-neutral-100">{dragging.name}</p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  def,
  count,
  draggable,
  children,
}: {
  def: ColumnDef;
  count: number;
  draggable: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: def.id, disabled: !draggable });
  return (
    <div className="flex w-64 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span
          title={def.hint}
          className={cn(
            "rounded px-1.5 py-0.5 text-xs font-normal",
            def.className,
          )}
        >
          {def.label}
        </span>
        <span className="text-xs tabular-nums text-neutral-600">{count}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[120px] flex-col gap-2 rounded-md p-1 transition-colors",
          isOver && "bg-white/[0.03] ring-1 ring-sky-500/30",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function BoardCard({
  company,
  draggable,
  onOpen,
  meta,
}: {
  company: CompanyWithIdle;
  draggable: boolean;
  onOpen: () => void;
  meta: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: company.id, disabled: !draggable });

  // A card is both a drag handle and a link, and the browser fires click at the
  // end of a drag too — so dropping a card into another column would also open
  // its drawer, every time. isDragging is already false by then, so the guard
  // has to be the pointer distance: a click stays put, a drag does not.
  const down = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setNodeRef}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      {...(draggable ? { ...listeners, ...attributes } : {})}
      onPointerDownCapture={(e) => {
        down.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        const start = down.current;
        down.current = null;
        if (start) {
          const moved =
            Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y);
          // Same 5px threshold the sensor uses to start a drag, so the two
          // cannot disagree about whether this was a click.
          if (moved > 5) return;
        }
        onOpen();
      }}
      className={cn(
        "cursor-pointer rounded-md border border-white/10 bg-neutral-900/60 p-2.5 transition-colors hover:border-white/20",
        isDragging && "opacity-40",
      )}
    >
      <p className="truncate text-sm text-neutral-100">{company.name}</p>
      {company.domain ? (
        <p className="truncate text-xs text-neutral-600">{company.domain}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">{meta}</div>
    </div>
  );
}
