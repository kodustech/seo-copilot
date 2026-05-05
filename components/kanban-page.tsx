"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
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
  Clipboard,
  ClipboardCheck,
  FileText,
  GripVertical,
  Hash,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Share2,
  Tag,
  Trash2,
  X,
  Zap,
} from "lucide-react";

import type {
  GrowthWorkItem,
  KanbanColumn,
  WorkItemPriority,
  WorkItemType,
  WorkItemSource,
} from "@/lib/kanban";
import {
  CONTENT_PIPELINE_TYPES,
  WORK_ITEM_TYPES,
  WORK_ITEM_PRIORITIES,
} from "@/lib/kanban";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/markdown-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
    update: "Update",
    task: "Task",
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

// Team members come from Supabase Auth — fetched live via /api/team/members
// so the assignee picker stays in sync as the team grows. The hardcoded list
// below is only used as a fallback while the request is in flight or if it
// fails (e.g. offline dev).
type TeamMember = { email: string; label: string };

const TEAM_MEMBERS_FALLBACK: TeamMember[] = [
  { email: "gabriel@kodus.io", label: "Gabriel" },
  { email: "junior.sartori@kodus.io", label: "Junior" },
  { email: "edvaldo.freitas@kodus.io", label: "Ed" },
];

function useTeamMembers(token: string | null): TeamMember[] {
  const [members, setMembers] = useState<TeamMember[]>(TEAM_MEMBERS_FALLBACK);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/team/members", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const fetched = data?.members as TeamMember[] | undefined;
        if (fetched && fetched.length > 0) setMembers(fetched);
      })
      .catch(() => {
        // Keep fallback on error
      });
    return () => {
      cancelled = true;
    };
  }, [token]);
  return members;
}

// Canonical columns per type filter. When filter is active, only columns whose
// name is in the canonical set for that type are rendered. "Backlog" is shared
// across all types (intake column). "Review" is shared between content + updates.
// Names are matched case-insensitively against existing column names.
// "Backlog" and "Next" are universal lanes (intake + prioritized) — appear in
// every type filter. Other columns are type-specific.
const CANONICAL_COLUMNS_BY_FILTER: Record<
  "content" | "update" | "task",
  string[]
> = {
  content: [
    "Backlog",
    "Next",
    "Research",
    "SEO Ready",
    "Drafting",
    "Review",
    "Scheduled",
    "Published",
    "Ready To Do",
  ],
  update: ["Backlog", "Next", "Editing", "Review", "Live"],
  task: ["Backlog", "Next", "Doing", "Blocked", "Done"],
};

// Macro stages used in the "All" view. Each card is bucketed into one of these
// 4 buckets based on its current stage (column slug). Maps every type's flow to
// a unified universe so cards can sit side by side without forcing the same
// column set on different types.
type MacroStage = "backlog" | "in_progress" | "review" | "done";

const MACRO_STAGES: { id: MacroStage; label: string; help: string }[] = [
  { id: "backlog", label: "Backlog", help: "Intake / not started" },
  {
    id: "in_progress",
    label: "In Progress",
    help: "Research / drafting / editing / next / doing",
  },
  { id: "review", label: "Review", help: "Pending review or blocked" },
  {
    id: "done",
    label: "Done",
    help: "Scheduled / published / live / done",
  },
];

// Map a stage slug (column.slug, lowercased) to a macro stage. Unknown slugs
// fall through to "backlog" as a safe default.
function macroStageFor(slug: string | null | undefined): MacroStage {
  const s = (slug ?? "").toLowerCase();
  if (s === "backlog" || s === "ready_to_do" || s === "ready to do") {
    // ready_to_do is an intake-ish column in the existing content board
    if (s === "backlog") return "backlog";
    return "backlog";
  }
  if (
    s === "research" ||
    s === "seo_ready" ||
    s === "drafting" ||
    s === "editing" ||
    s === "next" ||
    s === "doing"
  ) {
    return "in_progress";
  }
  if (s === "review" || s === "blocked") return "review";
  if (
    s === "scheduled" ||
    s === "published" ||
    s === "live" ||
    s === "done"
  ) {
    return "done";
  }
  return "backlog";
}

// When dragging a card to a macro column in "All" view, we need to pick a real
// stage to write back. Use a per-type canonical mapping so each card keeps its
// flow's semantics.
function canonicalStageForMacro(
  type: WorkItemType,
  macro: MacroStage,
): string {
  if (macro === "backlog") return "backlog";
  if (macro === "review") return "review";
  if (type === "task") {
    if (macro === "in_progress") return "doing";
    if (macro === "done") return "done";
  }
  if (type === "update") {
    if (macro === "in_progress") return "editing";
    if (macro === "done") return "live";
  }
  // content types (idea/keyword/title/article/social)
  if (macro === "in_progress") return "drafting";
  if (macro === "done") return "published";
  return "backlog";
}

function typeBadgeClass(t: WorkItemType) {
  if (t === "article") return "border-blue-500/40 bg-blue-500/10 text-blue-200";
  if (t === "social") return "border-cyan-500/40 bg-cyan-500/10 text-cyan-200";
  if (t === "title") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (t === "keyword") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  if (t === "update") return "border-violet-500/40 bg-violet-500/10 text-violet-200";
  if (t === "task") return "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200";
  return "border-neutral-500/40 bg-neutral-500/10 text-neutral-200";
}

function creatorInitials(email: string) {
  const name = email.split("@")[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Copy to LLM — bundles the card into a paste-ready prompt
// ---------------------------------------------------------------------------

const LLM_BRAND_PREAMBLE =
  `# Context\n\n` +
  `You are assisting the growth team at **Kodus** (open-source AI code review for engineering teams, https://kodus.io).\n\n` +
  `**Brand voice:** technical, direct, no marketing fluff.\n` +
  `**Audience:** senior engineers, eng leads, CTOs at SaaS companies.\n` +
  `**Differentiators:** IDE-native, multi-agent code review, customizable Kody Rules, MCP integrations, open-source.\n`;

const LLM_TASK_GENERIC =
  `Help me execute this card. Produce:\n\n` +
  `1. **Step-by-step plan** — concrete steps in order\n` +
  `2. **Decisions to make** — what choices need to be made and the rationale for each\n` +
  `3. **Risks / pitfalls** — what could go wrong\n` +
  `4. **What "done" looks like** — measurable criteria`;

const LLM_TASKS_BY_TYPE: Partial<Record<WorkItemType, string>> = {
  article:
    `Help me execute this content brief. Produce:\n\n` +
    `1. **Outline** (H2 / H3 structure)\n` +
    `2. **Opening 2 paragraphs** (≤200 words total) — establish intent fit, no marketing fluff\n` +
    `3. **3 internal-link suggestions** — for each: target kodus.io URL, anchor text (≤6 words), 1-line context where the link fits\n` +
    `4. **Title + meta** — 3 title variants (≤60 chars) + meta description (≤155 chars)\n` +
    `5. **Schema recommendation** — 1-2 schema types with sample JSON-LD`,
  update:
    `Help me ship this update. Produce:\n\n` +
    `1. **Decision** — what to change and why (be concrete)\n` +
    `2. **Before / after copy diffs** for the affected sections\n` +
    `3. **Schema or meta updates** if any (with sample JSON-LD)\n` +
    `4. **Internal-link sweep** — 3 inbound link sources with anchor text and paragraph context\n` +
    `5. **Validation step** — what to check in GSC after 14d to confirm the fix worked`,
  keyword:
    `Help me work this keyword card. Produce:\n\n` +
    `1. **Intent classification** — informational / commercial / transactional / navigational, with rationale\n` +
    `2. **Cluster** — 5-10 related queries that should live on the same page\n` +
    `3. **3 angle ideas** — distinct content angles for the cluster, each with a 1-line hook\n` +
    `4. **Existing fit** — does kodus.io already cover this? If yes, suggest update; if no, suggest new page slug`,
  title:
    `Help me draft titles for this card. Produce:\n\n` +
    `1. **5 title variants** (≤60 chars) — each testing a different angle (informational / comparative / commercial / contrarian / direct)\n` +
    `2. **Recommendation** — pick 1, explain why it's strongest for the target query / audience\n` +
    `3. **One H1** aligned with the chosen title\n` +
    `4. **Meta description** (≤155 chars) that pairs with the chosen title`,
  social:
    `Help me draft social posts for this card. Produce:\n\n` +
    `1. **LinkedIn post** (~150-250 words) — narrative angle, no marketing fluff, ends with a clear CTA\n` +
    `2. **Twitter/X thread** (3-5 tweets) — punchy, one idea per tweet, last tweet links out\n` +
    `3. **HN Show HN draft** if applicable — title + 2-paragraph post body with the technical angle\n` +
    `4. **Hashtags + handles** — relevant only, no spam`,
  idea:
    `Help me develop this idea. Produce:\n\n` +
    `1. **Problem-fit check** — what pain does it actually solve, who exactly\n` +
    `2. **3 distinct angles** to develop the idea, each with a 1-line hook\n` +
    `3. **Recommended next step** — research / spike / brief / kill, with rationale\n` +
    `4. **Risks** — what makes this idea unlikely to work`,
  task: LLM_TASK_GENERIC,
};

const TYPE_ISSUE_LABEL: Record<WorkItemType, string> = {
  idea: "Idea",
  keyword: "Keyword research",
  title: "Title drafting",
  article: "Article brief",
  social: "Social post",
  update: "Page update",
  task: "Task",
};

function stageLabelFromColumn(
  columns: KanbanColumn[],
  columnId: string | null,
): string {
  if (!columnId) return "Unassigned";
  const col = columns.find((c) => c.id === columnId);
  return col?.name ?? "Unassigned";
}

function buildKanbanLlmPrompt(
  item: GrowthWorkItem,
  columns: KanbanColumn[],
): string {
  const stage = stageLabelFromColumn(columns, item.columnId);
  const taskSpec = LLM_TASKS_BY_TYPE[item.itemType] ?? LLM_TASK_GENERIC;

  // Custom fields (the payload Map). Render as bullet list when present.
  const payloadEntries = Object.entries(item.payload ?? {}).filter(
    ([, v]) =>
      v !== null && v !== undefined && String(v).toString().trim().length > 0,
  );
  const customFieldsBlock =
    payloadEntries.length > 0
      ? `\n\n## Custom fields\n\n` +
        payloadEntries.map(([k, v]) => `- **${k}**: ${String(v)}`).join("\n")
      : "";

  const linkLine = item.link ? `**Link:** ${item.link}\n` : "";
  const responsibleLine = item.responsibleEmail
    ? `**Responsible:** ${item.responsibleEmail}\n`
    : "";

  const description =
    item.description?.trim() ||
    `_(no description on this card — infer the goal from the title and custom fields)_`;

  return (
    `${LLM_BRAND_PREAMBLE}\n` +
    `**Issue type:** ${TYPE_ISSUE_LABEL[item.itemType]} — ${priorityLabel(item.priority)} priority, in stage "${stage}"\n\n` +
    `# Card\n\n` +
    `**Title:** ${item.title}\n` +
    linkLine +
    responsibleLine +
    `\n## Description\n\n${description}` +
    customFieldsBlock +
    `\n\n---\n\n` +
    `# Now produce\n\n${taskSpec}\n\n` +
    `Output as markdown with clear H2/H3 sections. Be concrete (no "consider X") — make decisions and explain why.`
  );
}

// Compact button that copies the bundled card prompt to clipboard. Sits in
// the CardDetailModal top bar.
function CardCopyLlmButton({
  item,
  columns,
}: {
  item: GrowthWorkItem;
  columns: KanbanColumn[];
}) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildKanbanLlmPrompt(item, columns));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("[kanban] copy LLM prompt error:", err);
    }
  }, [item, columns]);
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition",
        copied
          ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
          : "border-white/10 bg-white/[0.04] text-neutral-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white",
      )}
      title={
        copied
          ? "Card copied — paste in your LLM"
          : "Copy a fully contextualized LLM prompt to clipboard"
      }
      aria-label={copied ? "Card copied" : "Copy LLM prompt"}
    >
      {copied ? (
        <>
          <ClipboardCheck className="size-3" /> Copied
        </>
      ) : (
        <>
          <Clipboard className="size-3" /> LLM
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Pipeline shortcuts — actions available from each card
// ---------------------------------------------------------------------------

type PipelineAction = {
  id: string;
  label: string;
  icon: React.ElementType;
  prompt: (title: string) => string;
};

const PIPELINE_ACTIONS: PipelineAction[] = [
  {
    id: "keywords",
    label: "Research Keywords",
    icon: Search,
    prompt: (t) => `Research SEO keywords for the topic: "${t}"`,
  },
  {
    id: "titles",
    label: "Generate Titles",
    icon: Hash,
    prompt: (t) => `Generate article title options for: "${t}"`,
  },
  {
    id: "article",
    label: "Write Article",
    icon: FileText,
    prompt: (t) => `Write a full blog article about: "${t}"`,
  },
  {
    id: "social",
    label: "Create Social Posts",
    icon: Share2,
    prompt: (t) => `Generate social media posts (LinkedIn + Twitter) about: "${t}"`,
  },
  {
    id: "canvas-blog",
    label: "Canvas: Blog Post",
    icon: Zap,
    prompt: (t) => t,
  },
  {
    id: "canvas-social",
    label: "Canvas: Social Post",
    icon: Zap,
    prompt: (t) => t,
  },
];

// ---------------------------------------------------------------------------
// Custom fields display & edit
// ---------------------------------------------------------------------------

function CustomFields({
  payload,
  onUpdate,
}: {
  payload: Record<string, unknown>;
  onUpdate: (payload: Record<string, unknown>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  // Filter out internal keys
  const fields = Object.entries(payload).filter(
    ([k]) => !k.startsWith("_"),
  );

  function handleAdd() {
    const key = newKey.trim();
    const value = newValue.trim();
    if (!key) return;
    onUpdate({ ...payload, [key]: value });
    setNewKey("");
    setNewValue("");
    setAdding(false);
  }

  function handleRemove(key: string) {
    const next = { ...payload };
    delete next[key];
    onUpdate(next);
  }

  return (
    <div className="space-y-1 pl-6">
      {fields.map(([key, value]) => (
        <div key={key} className="flex items-center gap-1.5 text-[10px]">
          <Tag className="size-2.5 shrink-0 text-neutral-600" />
          <span className="font-medium text-neutral-400">{key}:</span>
          <span className="min-w-0 truncate text-neutral-300">{String(value)}</span>
          <button
            className="ml-auto shrink-0 text-neutral-600 hover:text-red-400"
            onClick={() => handleRemove(key)}
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}

      {adding ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            autoFocus
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Field"
            className="h-5 w-16 border-none bg-transparent px-1 text-[10px] text-neutral-300 focus-visible:ring-0"
          />
          <Input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="Value"
            className="h-5 min-w-0 flex-1 border-none bg-transparent px-1 text-[10px] text-neutral-300 focus-visible:ring-0"
          />
          <button type="submit" className="text-emerald-400 hover:text-emerald-300">
            <Plus className="size-3" />
          </button>
          <button
            type="button"
            className="text-neutral-600 hover:text-neutral-400"
            onClick={() => {
              setAdding(false);
              setNewKey("");
              setNewValue("");
            }}
          >
            <X className="size-3" />
          </button>
        </form>
      ) : (
        <button
          className="flex items-center gap-1 text-[10px] text-neutral-600 transition hover:text-neutral-400"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-2.5" />
          Add field
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable Card
// ---------------------------------------------------------------------------

function SortableCard({
  item,
  overlay,
  onUpdatePayload,
  onAction,
  onDelete,
  onOpen,
}: {
  item: GrowthWorkItem;
  overlay?: boolean;
  onUpdatePayload?: (payload: Record<string, unknown>) => void;
  onAction?: (actionId: string) => void;
  onDelete?: () => void;
  onOpen?: () => void;
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

  const hasCustomFields = Object.keys(item.payload).some((k) => !k.startsWith("_"));

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
        <button
          className="line-clamp-2 min-w-0 flex-1 text-left text-pretty text-sm font-medium text-neutral-100 hover:text-white"
          onClick={onOpen}
        >
          {item.title}
        </button>

        {/* Card actions: pipeline shortcuts + delete */}
        {(onAction || onDelete) && (
          <Popover>
            <PopoverTrigger asChild>
              <button className="shrink-0 rounded p-0.5 text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-neutral-300">
                <MoreHorizontal className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="bottom"
              className="w-48 border-white/10 bg-neutral-950 p-1 text-neutral-100"
            >
              {onAction && CONTENT_PIPELINE_TYPES.includes(item.itemType) && (
                <>
                  <p className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                    Pipeline
                  </p>
                  {PIPELINE_ACTIONS.map((action) => {
                    const Icon = action.icon;
                    return (
                      <Button
                        key={action.id}
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-xs text-neutral-300 hover:bg-white/10 hover:text-white"
                        onClick={() => onAction(action.id)}
                      >
                        <Icon className="mr-2 size-3.5" />
                        {action.label}
                      </Button>
                    );
                  })}
                </>
              )}
              {onDelete && (
                <>
                  {CONTENT_PIPELINE_TYPES.includes(item.itemType) && (
                    <div className={cn("my-1 h-px", "bg-white/10")} />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    onClick={onDelete}
                  >
                    <Trash2 className="mr-2 size-3.5" />
                    Delete card
                  </Button>
                </>
              )}
            </PopoverContent>
          </Popover>
        )}
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
        <span className="ml-auto flex items-center gap-1 text-[10px] text-neutral-500">
          {item.responsibleEmail && (
            <span
              className="flex size-5 items-center justify-center rounded-full bg-sky-500/20 text-[9px] font-semibold text-sky-200 ring-1 ring-sky-500/40"
              title={`Responsible: ${item.responsibleEmail}`}
            >
              {creatorInitials(item.responsibleEmail)}
            </span>
          )}
          <span
            className="flex size-5 items-center justify-center rounded-full bg-white/10 text-[9px] font-semibold text-neutral-300"
            title={`Created by: ${item.userEmail}`}
          >
            {creatorInitials(item.userEmail)}
          </span>
        </span>
      </div>

      {/* Custom fields */}
      {(hasCustomFields || !overlay) && onUpdatePayload && (
        <CustomFields payload={item.payload} onUpdate={onUpdatePayload} />
      )}
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

// Compact two-column property row used inside the CardDetailModal grid.
function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <span className="w-20 shrink-0 text-[11px] text-neutral-500">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card Detail Modal (Notion-style)
// ---------------------------------------------------------------------------

function CardDetailModal({
  item,
  columns,
  teamMembers,
  open,
  onClose,
  onUpdate,
  onDelete,
  onAction,
}: {
  item: GrowthWorkItem;
  columns: KanbanColumn[];
  teamMembers: TeamMember[];
  open: boolean;
  onClose: () => void;
  onUpdate: (updates: Record<string, unknown>) => void;
  onDelete: () => void;
  onAction: (actionId: string) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? "");
  const [editingDescription, setEditingDescription] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // Sync when item changes
  useEffect(() => {
    setTitle(item.title);
    setDescription(item.description ?? "");
    setEditingDescription(false);
  }, [item.id, item.title, item.description]);

  // Auto-resize title textarea
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = "auto";
      titleRef.current.style.height = titleRef.current.scrollHeight + "px";
    }
  }, [title]);

  function commitTitle() {
    const trimmed = title.trim();
    if (trimmed && trimmed !== item.title) onUpdate({ title: trimmed });
  }

  function commitDescription() {
    const val = description.trim();
    if (val !== (item.description ?? "")) onUpdate({ description: val || null });
  }

  const currentCol = columns.find((c) => c.id === item.columnId);
  const customFields = Object.entries(item.payload).filter(([k]) => !k.startsWith("_"));

  // Custom field management
  const [addingField, setAddingField] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");

  function handleAddField() {
    const key = newFieldKey.trim();
    if (!key) return;
    onUpdate({ payload: { ...item.payload, [key]: newFieldValue.trim() } });
    setNewFieldKey("");
    setNewFieldValue("");
    setAddingField(false);
  }

  function handleRemoveField(key: string) {
    const next = { ...item.payload };
    delete next[key];
    onUpdate({ payload: next });
  }

  function handleFieldValueChange(key: string, value: string) {
    onUpdate({ payload: { ...item.payload, [key]: value } });
  }

  // Pretty creator label + relative timestamp for the top bar so the
  // properties grid can drop the "Created by" / "Created" rows.
  const createdAt = new Date(item.createdAt);
  const createdAgo = (() => {
    const days = Math.floor((Date.now() - createdAt.getTime()) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  })();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[85vh] overflow-y-auto border-white/10 bg-neutral-950 p-0 text-neutral-100 sm:max-w-2xl"
      >
        {/* Top bar — type / priority / creator+date / actions */}
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-neutral-950/95 px-5 py-2.5 backdrop-blur">
          <Badge variant="outline" className={cn("text-[10px]", typeBadgeClass(item.itemType))}>
            {typeLabel(item.itemType)}
          </Badge>
          <Badge variant="outline" className={cn("text-[10px]", priorityBadgeClass(item.priority))}>
            {priorityLabel(item.priority)}
          </Badge>
          <div
            className="ml-auto flex items-center gap-1.5 text-[11px] text-neutral-500"
            title={`Created ${createdAt.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}`}
          >
            <span className="flex size-5 items-center justify-center rounded-full bg-white/10 text-[9px] font-semibold text-neutral-300">
              {creatorInitials(item.userEmail)}
            </span>
            <span>{item.userEmail.split("@")[0]}</span>
            <span className="text-neutral-700">·</span>
            <span>{createdAgo}</span>
          </div>
          <CardCopyLlmButton item={item} columns={columns} />
          <button
            className="rounded p-1 text-neutral-500 hover:bg-white/10 hover:text-neutral-200"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Title — editable, no scrollbar even on long titles */}
        <div className="px-5 pb-1 pt-5">
          <textarea
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            rows={1}
            className="w-full resize-none overflow-hidden break-words border-none bg-transparent p-0 text-2xl font-semibold leading-tight tracking-tight text-white placeholder:text-neutral-600 focus:outline-none"
            placeholder="Untitled"
            style={{ wordBreak: "break-word" }}
          />
          {item.link && (
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-[11px] text-neutral-500 hover:text-neutral-300"
              title={item.link}
            >
              {item.link.replace(/^https?:\/\//, "")}
            </a>
          )}
        </div>

        {/* Properties — compact 2-col grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 px-5 pb-3">
          <PropertyRow label="Column">
            <Select
              value={item.columnId ?? ""}
              onValueChange={(v) => {
                const col = columns.find((c) => c.id === v);
                onUpdate({ columnId: v, stage: col?.slug });
              }}
            >
              <SelectTrigger className="h-6 border-none bg-transparent px-1.5 text-xs text-neutral-200 hover:bg-white/5 focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                {columns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>
          <PropertyRow label="Type">
            <Select
              value={item.itemType}
              onValueChange={(v) => onUpdate({ itemType: v })}
            >
              <SelectTrigger className="h-6 border-none bg-transparent px-1.5 text-xs text-neutral-200 hover:bg-white/5 focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                {WORK_ITEM_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {typeLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>
          <PropertyRow label="Priority">
            <Select
              value={item.priority}
              onValueChange={(v) => onUpdate({ priority: v })}
            >
              <SelectTrigger className="h-6 border-none bg-transparent px-1.5 text-xs text-neutral-200 hover:bg-white/5 focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                {WORK_ITEM_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {priorityLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>
          <PropertyRow label="Responsible">
            <Select
              value={item.responsibleEmail ?? "__unassigned__"}
              onValueChange={(v) =>
                onUpdate({ responsibleEmail: v === "__unassigned__" ? null : v })
              }
            >
              <SelectTrigger className="h-6 border-none bg-transparent px-1.5 text-xs text-neutral-200 hover:bg-white/5 focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                <SelectItem value="__unassigned__">Unassigned</SelectItem>
                {teamMembers.map((m) => (
                  <SelectItem key={m.email} value={m.email}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>

          {/* Custom fields — span both columns since values can be long */}
          {customFields.length > 0 && (
            <div className="col-span-2 mt-1 space-y-0.5">
              {customFields.map(([key, value]) => (
                <div key={key} className="group flex items-center gap-3 rounded py-0.5">
                  <span
                    className="w-24 shrink-0 truncate text-[11px] text-neutral-500"
                    title={key}
                  >
                    {key}
                  </span>
                  <input
                    className="min-w-0 flex-1 border-none bg-transparent px-1.5 text-xs text-neutral-300 placeholder:text-neutral-600 focus:outline-none focus:ring-0"
                    defaultValue={String(value)}
                    onBlur={(e) => handleFieldValueChange(key, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <button
                    className="shrink-0 text-neutral-700 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                    onClick={() => handleRemoveField(key)}
                    aria-label={`Remove ${key}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add field — full width */}
          <div className="col-span-2 pt-1">
            {addingField ? (
              <form
                className="flex items-center gap-2 py-0.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleAddField();
                }}
              >
                <input
                  autoFocus
                  value={newFieldKey}
                  onChange={(e) => setNewFieldKey(e.target.value)}
                  placeholder="Property name"
                  className="w-24 shrink-0 border-none bg-transparent text-xs text-neutral-400 placeholder:text-neutral-600 focus:outline-none"
                />
                <input
                  value={newFieldValue}
                  onChange={(e) => setNewFieldValue(e.target.value)}
                  placeholder="Value"
                  className="min-w-0 flex-1 border-none bg-transparent px-1.5 text-xs text-neutral-300 placeholder:text-neutral-600 focus:outline-none"
                />
                <button type="submit" className="text-emerald-400 hover:text-emerald-300">
                  <Plus className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="text-neutral-600 hover:text-neutral-400"
                  onClick={() => {
                    setAddingField(false);
                    setNewFieldKey("");
                    setNewFieldValue("");
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </form>
            ) : (
              <button
                className="flex items-center gap-1.5 text-[11px] text-neutral-600 transition hover:text-neutral-400"
                onClick={() => setAddingField(true)}
              >
                <Plus className="size-3" />
                Add property
              </button>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="mx-5 h-px bg-white/10" />

        {/* Description — editable; renders as Markdown when not editing */}
        <div className="px-5 py-3">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              Description
            </p>
            {description && !editingDescription && (
              <button
                className="text-[10px] text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
                onClick={() => setEditingDescription(true)}
              >
                edit
              </button>
            )}
            {editingDescription && (
              <span className="text-[10px] text-neutral-600">
                Markdown supported (headings, lists, code, tables, links)
              </span>
            )}
          </div>
          {editingDescription || !description ? (
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                commitDescription();
                if (description.trim()) setEditingDescription(false);
              }}
              autoFocus={editingDescription}
              placeholder="Add a description... (Markdown supported)"
              className="min-h-[140px] resize-y border-none bg-transparent px-0 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:ring-0"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingDescription(true)}
              className="block w-full cursor-text rounded text-left transition hover:bg-white/[0.02]"
              title="Click to edit"
            >
              <MarkdownContent text={description} />
            </button>
          )}
        </div>

        {/* Divider */}
        <div className="mx-5 h-px bg-white/10" />

        {/* Actions footer — only for content types (article/idea/keyword/title/social).
            'update' and 'task' are non-content; pipeline gen actions are not relevant. */}
        {CONTENT_PIPELINE_TYPES.includes(item.itemType) && (
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-600">
            Pipeline
          </p>
          {PIPELINE_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <Button
                key={action.id}
                variant="outline"
                size="sm"
                className="h-7 border-white/10 bg-transparent text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
                onClick={() => {
                  onClose();
                  onAction(action.id);
                }}
              >
                <Icon className="mr-1.5 size-3" />
                {action.label}
              </Button>
            );
          })}
        </div>
        )}

        {/* Delete footer — always visible regardless of type */}
        <div className="flex justify-end px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-red-500/70 hover:bg-red-500/10 hover:text-red-400"
            onClick={() => {
              onClose();
              onDelete();
            }}
          >
            <Trash2 className="mr-1.5 size-3" />
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Droppable column wrapper
// ---------------------------------------------------------------------------

function DroppableColumn({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-[60px] flex-col gap-2 rounded-md transition-colors",
        isOver && "bg-white/[0.03] ring-1 ring-sky-500/30",
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick add card (inline at top of column)
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
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-500 transition hover:bg-white/5 hover:text-neutral-300"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" />
        Add card
      </button>
    );
  }

  return (
    <form
      className="space-y-2 rounded-lg border border-white/10 bg-neutral-950 p-2"
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
        className="h-7 border-none bg-transparent px-1 text-sm text-neutral-100 placeholder:text-neutral-600 focus-visible:ring-0"
        disabled={loading}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setTitle("");
          }
        }}
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          className="h-6 bg-white px-3 text-xs text-neutral-900 hover:bg-neutral-200"
          disabled={loading}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : "Add"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-neutral-500"
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

type TypeFilter = "all" | "content" | "update" | "task";
// Responsible filter: "all" = everyone, "__unassigned__" = no responsible set,
// otherwise = email string
type ResponsibleFilter = "all" | "__unassigned__" | string;
type PriorityFilter = "all" | WorkItemPriority;
type SortMode = "position" | "priority";

const PRIORITY_RANK: Record<WorkItemPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function KanbanPage() {
  const token = useAuthToken();
  const teamMembers = useTeamMembers(token);
  const router = useRouter();
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [items, setItems] = useState<GrowthWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingCardCol, setAddingCardCol] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<GrowthWorkItem | null>(null);
  const [selectedCard, setSelectedCard] = useState<GrowthWorkItem | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [responsibleFilter, setResponsibleFilter] =
    useState<ResponsibleFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("position");
  const [searchQuery, setSearchQuery] = useState("");

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

  const filteredItems = useMemo(() => {
    let result = items;
    if (typeFilter === "update") {
      result = result.filter((i) => i.itemType === "update");
    } else if (typeFilter === "task") {
      result = result.filter((i) => i.itemType === "task");
    } else if (typeFilter === "content") {
      // "content" = the original content-pipeline types
      result = result.filter((i) => CONTENT_PIPELINE_TYPES.includes(i.itemType));
    }
    // typeFilter === "all" → no type filter applied

    if (responsibleFilter === "__unassigned__") {
      result = result.filter((i) => !i.responsibleEmail);
    } else if (responsibleFilter !== "all") {
      result = result.filter((i) => i.responsibleEmail === responsibleFilter);
    }

    if (priorityFilter !== "all") {
      result = result.filter((i) => i.priority === priorityFilter);
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter((i) => {
        const haystack = [
          i.title,
          i.description ?? "",
          i.responsibleEmail ?? "",
          i.userEmail,
        ]
          .join("\n")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    return result;
  }, [items, typeFilter, responsibleFilter, priorityFilter, searchQuery]);

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

  // Visible columns based on the active type filter. When filter is "all", we
  // render synthetic macro columns instead (handled in displayColumns below).
  // For type-specific filters, show only columns whose name matches the
  // canonical set (case-insensitive) AND order them by the canonical sequence
  // — not by their DB position. The canonical order encodes the workflow
  // (Backlog → Next → in-progress → Review → terminal).
  const visibleColumns = useMemo(() => {
    if (typeFilter === "all") return columns;
    const canonical = CANONICAL_COLUMNS_BY_FILTER[typeFilter];
    if (!canonical.length) return columns;
    const orderIndex = new Map<string, number>();
    canonical.forEach((name, idx) =>
      orderIndex.set(name.toLowerCase(), idx),
    );
    return columns
      .filter((c) => orderIndex.has(c.name.toLowerCase()))
      .sort((a, b) => {
        const ai = orderIndex.get(a.name.toLowerCase()) ?? 999;
        const bi = orderIndex.get(b.name.toLowerCase()) ?? 999;
        return ai - bi;
      });
  }, [columns, typeFilter]);

  // What we actually render. In "all" mode, synthetic macro columns. Otherwise,
  // the type-filtered real columns.
  type DisplayColumn = {
    id: string;
    name: string;
    isMacro: boolean;
    macroId?: MacroStage;
    realColumn?: KanbanColumn;
    helpText?: string;
  };

  const displayColumns = useMemo<DisplayColumn[]>(() => {
    if (typeFilter === "all") {
      return MACRO_STAGES.map((m) => ({
        id: `macro:${m.id}`,
        name: m.label,
        isMacro: true,
        macroId: m.id,
        helpText: m.help,
      }));
    }
    return visibleColumns.map((c) => ({
      id: c.id,
      name: c.name,
      isMacro: false,
      realColumn: c,
    }));
  }, [typeFilter, visibleColumns]);

  const itemsByDisplayColumn = useMemo(() => {
    const map = new Map<string, GrowthWorkItem[]>();
    for (const dc of displayColumns) map.set(dc.id, []);

    if (typeFilter === "all") {
      for (const item of filteredItems) {
        const macro = macroStageFor(item.stage);
        const dcId = `macro:${macro}`;
        const bucket = map.get(dcId);
        if (bucket) bucket.push(item);
      }
    } else {
      for (const item of filteredItems) {
        const colId = item.columnId;
        if (colId && map.has(colId)) {
          map.get(colId)!.push(item);
        } else if (displayColumns.length > 0) {
          map.get(displayColumns[0].id)!.push(item);
        }
      }
    }

    for (const [, list] of map) {
      if (sortMode === "priority") {
        list.sort((a, b) => {
          const rankA = PRIORITY_RANK[a.priority] ?? 99;
          const rankB = PRIORITY_RANK[b.priority] ?? 99;
          if (rankA !== rankB) return rankA - rankB;
          return a.position - b.position;
        });
      } else {
        list.sort((a, b) => a.position - b.position);
      }
    }

    return map;
  }, [displayColumns, filteredItems, typeFilter, sortMode]);

  // Canonical columns for the current filter that don't exist yet — shown as a
  // "create missing" hint. Only meaningful when filter is type-specific.
  const missingCanonicalColumns = useMemo(() => {
    if (typeFilter === "all") return [];
    const expected = CANONICAL_COLUMNS_BY_FILTER[typeFilter];
    if (!expected.length) return [];
    const existingLower = new Set(columns.map((c) => c.name.toLowerCase()));
    return expected.filter((n) => !existingLower.has(n.toLowerCase()));
  }, [columns, typeFilter]);

  async function setupCanonicalColumnsForFilter() {
    if (typeFilter === "all" || !missingCanonicalColumns.length) return;
    for (const name of missingCanonicalColumns) {
      await handleAddColumn(name);
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

  async function handleUpdatePayload(itemId: string, payload: Record<string, unknown>) {
    if (!token) return;
    // Optimistic update
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, payload } : i)),
    );
    await fetch(`/api/kanban/items/${itemId}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ payload }),
    });
  }

  async function handleUpdateCard(itemId: string, updates: Record<string, unknown>) {
    if (!token) return;
    // Optimistic update
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId ? { ...i, ...updates } : i,
      ),
    );
    // Also update selectedCard if it's the one being edited
    setSelectedCard((prev) =>
      prev?.id === itemId ? { ...prev, ...updates } as GrowthWorkItem : prev,
    );
    await fetch(`/api/kanban/items/${itemId}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify(updates),
    });
  }

  async function handleDeleteCard(itemId: string) {
    if (!token) return;
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    await fetch(`/api/kanban/items/${itemId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
  }

  // ---- Pipeline shortcuts ----

  function handlePipelineAction(item: GrowthWorkItem, actionId: string) {
    const action = PIPELINE_ACTIONS.find((a) => a.id === actionId);
    if (!action) return;

    if (actionId === "canvas-blog") {
      router.push(`/?topic=${encodeURIComponent(item.title)}&mode=blog`);
      return;
    }
    if (actionId === "canvas-social") {
      router.push(`/?topic=${encodeURIComponent(item.title)}&mode=social`);
      return;
    }

    const prompt = action.prompt(item.title);
    router.push(`/?prompt=${encodeURIComponent(prompt)}`);
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

    const activeItem = items.find((i) => i.id === activeId);
    if (!activeItem) return;

    const sourceColId = activeItem.columnId;
    const isOverColumn = columns.some((c) => c.id === overId);
    const destColId = isOverColumn
      ? overId
      : items.find((i) => i.id === overId)?.columnId;

    if (!destColId || sourceColId === destColId) return;

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

    // Macro view drop: target id is "macro:<id>". Update stage to the canonical
    // value for that card's type + macro, and pick the real column whose slug
    // matches that stage (creating the column is out of scope here — assume the
    // user has set up the canonical columns for this type at least once).
    if (overId.startsWith("macro:")) {
      const macroId = overId.slice("macro:".length) as MacroStage;
      const targetStage = canonicalStageForMacro(item.itemType, macroId);
      // Find a column whose slug matches the canonical stage. If none, fall
      // back to first column of the canonical set for the item's type.
      const targetCol =
        columns.find((c) => c.slug === targetStage) ??
        columns.find((c) => c.name.toLowerCase() === targetStage);
      if (!targetCol || !token) return;
      await fetch(`/api/kanban/items/${activeId}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          columnId: targetCol.id,
          stage: targetCol.slug ?? targetStage,
        }),
      });
      return;
    }

    const isOverColumn = columns.some((c) => c.id === overId);
    const destColId = isOverColumn
      ? overId
      : items.find((i) => i.id === overId)?.columnId ?? item.columnId;

    if (!destColId || !token) return;

    const destCol = columns.find((c) => c.id === destColId);

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
          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search title / description / owner..."
                className="h-9 w-64 border-white/10 bg-neutral-900 pl-8 pr-7 text-xs text-neutral-200 placeholder:text-neutral-600"
              />
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-neutral-500" />
              {searchQuery && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-200"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            {/* Type filter tabs */}
            <div className="flex items-center gap-1 rounded-md border border-white/10 bg-neutral-900 p-1">
              {(
                [
                  { id: "all", label: "All" },
                  { id: "content", label: "Content" },
                  { id: "update", label: "Updates" },
                  { id: "task", label: "Tasks" },
                ] as { id: TypeFilter; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs transition",
                    typeFilter === opt.id
                      ? "bg-white/10 text-white"
                      : "text-neutral-400 hover:text-neutral-200",
                  )}
                  onClick={() => setTypeFilter(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Responsible filter */}
            <Select
              value={responsibleFilter}
              onValueChange={(v) => setResponsibleFilter(v as ResponsibleFilter)}
            >
              <SelectTrigger className="h-9 w-40 border-white/10 bg-neutral-900 text-xs text-neutral-200 hover:bg-neutral-800">
                <SelectValue placeholder="Responsible" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                <SelectItem value="all">Everyone</SelectItem>
                <SelectItem value="__unassigned__">Unassigned</SelectItem>
                {teamMembers.map((m) => (
                  <SelectItem key={m.email} value={m.email}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Priority filter */}
            <Select
              value={priorityFilter}
              onValueChange={(v) => setPriorityFilter(v as PriorityFilter)}
            >
              <SelectTrigger className="h-9 w-32 border-white/10 bg-neutral-900 text-xs text-neutral-200 hover:bg-neutral-800">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-neutral-950 text-neutral-200">
                <SelectItem value="all">Any priority</SelectItem>
                <SelectItem value="high">High only</SelectItem>
                <SelectItem value="medium">Medium only</SelectItem>
                <SelectItem value="low">Low only</SelectItem>
              </SelectContent>
            </Select>

            {/* Sort mode toggle */}
            <button
              className={cn(
                "flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs transition",
                sortMode === "priority"
                  ? "border-violet-500/40 bg-violet-500/10 text-violet-200"
                  : "border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800",
              )}
              title={
                sortMode === "priority"
                  ? "Sorted by priority (high → low). Click to switch back to manual order."
                  : "Sorted by manual position. Click to sort by priority."
              }
              onClick={() =>
                setSortMode((m) => (m === "priority" ? "position" : "priority"))
              }
            >
              {sortMode === "priority" ? "↓ Priority" : "↕ Position"}
            </button>

            <Button
              variant="outline"
              size="sm"
              className="border-white/15 bg-transparent text-neutral-300 hover:bg-white/10"
              onClick={() => void loadBoard()}
            >
              <RefreshCcw className="mr-1.5 size-4" />
              Refresh
            </Button>
          </div>
        </header>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {missingCanonicalColumns.length > 0 && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
              <div className="text-amber-200">
                <strong className="font-semibold">
                  Missing columns for "{typeFilter}" view:
                </strong>{" "}
                <span className="text-amber-300/80">
                  {missingCanonicalColumns.join(" · ")}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
                onClick={() => void setupCanonicalColumnsForFilter()}
              >
                Create columns
              </Button>
            </div>
          )}

          {typeFilter === "all" && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs text-violet-200">
              <span className="font-medium">Macro view</span>
              <span className="text-violet-300/70">
                · Cards bucketed by stage into 4 universal columns. Switch to a
                type filter (Content/Updates/Tasks) to see real columns and drag
                between them.
              </span>
            </div>
          )}

          <div className="flex gap-4 overflow-x-auto pb-4">
            {displayColumns.map((dc) => {
              const colItems = itemsByDisplayColumn.get(dc.id) ?? [];
              return (
                <div
                  key={dc.id}
                  className="w-[300px] shrink-0 rounded-lg border border-white/10 bg-neutral-900/50 p-3"
                >
                  {dc.isMacro ? (
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-neutral-100">
                          {dc.name}
                        </h3>
                        <p className="text-[10px] text-neutral-500">
                          {dc.helpText}
                        </p>
                      </div>
                      <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-neutral-400">
                        {colItems.length}
                      </span>
                    </div>
                  ) : (
                    <ColumnHeader
                      column={dc.realColumn!}
                      count={colItems.length}
                      onRename={(name) =>
                        handleRenameColumn(dc.realColumn!.id, name)
                      }
                      onDelete={() => handleDeleteColumn(dc.realColumn!.id)}
                    />
                  )}

                  {/* Add card — only in real columns. Macro columns are read-only. */}
                  {!dc.isMacro && dc.realColumn && (
                    <div className="mb-2">
                      <QuickAddCard
                        onAdd={(title) =>
                          handleAddCard(dc.realColumn!.id, title)
                        }
                        loading={addingCardCol === dc.realColumn!.id}
                      />
                    </div>
                  )}

                  <SortableContext
                    id={dc.id}
                    items={colItems.map((i) => i.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <DroppableColumn id={dc.id}>
                      {colItems.map((item) => (
                        <SortableCard
                          key={item.id}
                          item={item}
                          onUpdatePayload={(payload) =>
                            handleUpdatePayload(item.id, payload)
                          }
                          onAction={(actionId) =>
                            handlePipelineAction(item, actionId)
                          }
                          onDelete={() => handleDeleteCard(item.id)}
                          onOpen={() => setSelectedCard(item)}
                        />
                      ))}
                    </DroppableColumn>
                  </SortableContext>
                </div>
              );
            })}

            {typeFilter !== "all" && <AddColumnForm onAdd={handleAddColumn} />}
          </div>

          <DragOverlay>
            {activeItem ? <SortableCard item={activeItem} overlay /> : null}
          </DragOverlay>
        </DndContext>

        {/* Card detail modal */}
        {selectedCard && (
          <CardDetailModal
            item={selectedCard}
            columns={columns}
            teamMembers={teamMembers}
            open
            onClose={() => setSelectedCard(null)}
            onUpdate={(updates) => handleUpdateCard(selectedCard.id, updates)}
            onDelete={() => {
              handleDeleteCard(selectedCard.id);
              setSelectedCard(null);
            }}
            onAction={(actionId) => {
              handlePipelineAction(selectedCard, actionId);
              setSelectedCard(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
