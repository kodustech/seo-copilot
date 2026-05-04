import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkItemType =
  | "idea"
  | "keyword"
  | "title"
  | "article"
  | "social"
  // Non-content work tracked on the same board:
  | "update" // existing-page improvement (CTR fix, schema, refresh, rewrite)
  | "task"; // generic ops/dev/decision (build endpoint, rotate token, write spec)
export type WorkItemSource = "manual" | "blog" | "changelog" | "agent" | "n8n";
export type WorkItemPriority = "low" | "medium" | "high";
export type WorkItemStage =
  // Content creation lifecycle (default):
  | "backlog"
  | "research"
  | "seo_ready"
  | "drafting"
  | "review"
  | "scheduled"
  | "published"
  // Content update lifecycle:
  | "editing"
  | "live"
  // Generic task lifecycle:
  | "next"
  | "doing"
  | "blocked"
  | "done";

export type StageDefinition = {
  id: WorkItemStage;
  label: string;
  help: string;
};

// Default stages = content creation flow (preserved for backward compat).
// Columns are user-configurable in the UI; stage values are slug-derived from
// column names, so any new column slug works as a stage value.
export const KANBAN_STAGES: StageDefinition[] = [
  { id: "backlog", label: "Backlog", help: "Raw opportunities and ideas." },
  { id: "research", label: "Research", help: "Keywords, context, and references." },
  { id: "seo_ready", label: "SEO Ready", help: "Keyword and title are selected." },
  { id: "drafting", label: "Drafting", help: "Article or social draft in progress." },
  { id: "review", label: "Review", help: "Content or strategy validation." },
  { id: "scheduled", label: "Scheduled", help: "Already scheduled for publishing." },
  { id: "published", label: "Published", help: "Published and ready for follow-up." },
];

export const WORK_ITEM_TYPES: WorkItemType[] = [
  "idea",
  "keyword",
  "title",
  "article",
  "social",
  "update",
  "task",
];

// Item types that follow the content-creation gen pipeline (research → write → publish).
// UI uses this to decide whether to show pipeline actions ("Generate keywords",
// "Generate article", etc.). 'update' and 'task' are intentionally excluded — they
// don't need content generation.
export const CONTENT_PIPELINE_TYPES: WorkItemType[] = [
  "idea",
  "keyword",
  "title",
  "article",
  "social",
];

export const WORK_ITEM_SOURCES: WorkItemSource[] = [
  "manual",
  "blog",
  "changelog",
  "agent",
  "n8n",
];

export const WORK_ITEM_PRIORITIES: WorkItemPriority[] = ["low", "medium", "high"];

// ---------------------------------------------------------------------------
// Kanban Column
// ---------------------------------------------------------------------------

export type KanbanColumn = {
  id: string;
  name: string;
  slug: string;
  position: number;
  createdAt: string;
};

type KanbanColumnRow = {
  id: string;
  name: string;
  slug: string;
  position: number;
  created_at: string;
};

function rowToColumn(row: KanbanColumnRow): KanbanColumn {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    position: row.position,
    createdAt: row.created_at,
  };
}

export async function listColumns(
  client: SupabaseClient,
): Promise<KanbanColumn[]> {
  const { data, error } = await client
    .from("kanban_columns")
    .select("*")
    .order("position", { ascending: true });

  if (error) throw new Error(`Error loading columns: ${error.message}`);
  return ((data ?? []) as KanbanColumnRow[]).map(rowToColumn);
}

export async function createColumn(
  client: SupabaseClient,
  input: { name: string; position?: number },
): Promise<KanbanColumn> {
  const name = input.name.trim();
  if (!name) throw new Error("Column name is required.");

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  // If no position, put at end
  let position = input.position;
  if (position === undefined) {
    const { data } = await client
      .from("kanban_columns")
      .select("position")
      .order("position", { ascending: false })
      .limit(1);
    position = ((data?.[0] as KanbanColumnRow | undefined)?.position ?? -1) + 1;
  }

  const { data, error } = await client
    .from("kanban_columns")
    .insert({ name, slug, position })
    .select("*")
    .single();

  if (error) throw new Error(`Error creating column: ${error.message}`);
  return rowToColumn(data as KanbanColumnRow);
}

export async function updateColumn(
  client: SupabaseClient,
  columnId: string,
  updates: { name?: string; position?: number },
): Promise<KanbanColumn> {
  const patch: Record<string, unknown> = {};
  if (updates.name !== undefined) {
    const name = updates.name.trim();
    if (!name) throw new Error("Column name cannot be empty.");
    patch.name = name;
    patch.slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }
  if (updates.position !== undefined) {
    patch.position = updates.position;
  }

  if (!Object.keys(patch).length) throw new Error("No valid updates.");

  const { data, error } = await client
    .from("kanban_columns")
    .update(patch)
    .eq("id", columnId)
    .select("*")
    .single();

  if (error) throw new Error(`Error updating column: ${error.message}`);
  return rowToColumn(data as KanbanColumnRow);
}

export async function deleteColumn(
  client: SupabaseClient,
  columnId: string,
  fallbackColumnId?: string,
): Promise<void> {
  // Move cards to fallback column (first column by default)
  if (fallbackColumnId) {
    await client
      .from("growth_work_items")
      .update({ column_id: fallbackColumnId })
      .eq("column_id", columnId);
  } else {
    const { data: cols } = await client
      .from("kanban_columns")
      .select("id")
      .neq("id", columnId)
      .order("position", { ascending: true })
      .limit(1);
    const fallback = (cols?.[0] as { id: string } | undefined)?.id;
    if (fallback) {
      await client
        .from("growth_work_items")
        .update({ column_id: fallback })
        .eq("column_id", columnId);
    }
  }

  const { error } = await client
    .from("kanban_columns")
    .delete()
    .eq("id", columnId);

  if (error) throw new Error(`Error deleting column: ${error.message}`);
}

export async function reorderColumns(
  client: SupabaseClient,
  orderedIds: string[],
): Promise<void> {
  const updates = orderedIds.map((id, index) => ({ id, position: index }));
  for (const u of updates) {
    await client
      .from("kanban_columns")
      .update({ position: u.position })
      .eq("id", u.id);
  }
}

// ---------------------------------------------------------------------------
// Work Item
// ---------------------------------------------------------------------------

export type GrowthWorkItem = {
  id: string;
  userEmail: string;
  title: string;
  description: string | null;
  itemType: WorkItemType;
  stage: WorkItemStage;
  columnId: string | null;
  position: number;
  source: WorkItemSource;
  sourceRef: string | null;
  priority: WorkItemPriority;
  link: string | null;
  dueAt: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type GrowthWorkItemRow = {
  id: string;
  user_email: string;
  title: string;
  description: string | null;
  item_type: string;
  stage: string;
  column_id: string | null;
  position: number;
  source: string;
  source_ref: string | null;
  priority: string;
  link: string | null;
  due_at: string | null;
  payload: unknown;
  created_at: string;
  updated_at: string;
};

export type CreateWorkItemInput = {
  title: string;
  description?: string | null;
  itemType?: WorkItemType;
  stage?: WorkItemStage;
  columnId?: string | null;
  source?: WorkItemSource;
  sourceRef?: string | null;
  priority?: WorkItemPriority;
  link?: string | null;
  dueAt?: string | null;
  payload?: Record<string, unknown>;
};

export type UpdateWorkItemInput = Partial<CreateWorkItemInput>;

export function normalizeWorkItemType(value: unknown): WorkItemType {
  return WORK_ITEM_TYPES.includes(value as WorkItemType)
    ? (value as WorkItemType)
    : "idea";
}

export function normalizeWorkItemSource(value: unknown): WorkItemSource {
  return WORK_ITEM_SOURCES.includes(value as WorkItemSource)
    ? (value as WorkItemSource)
    : "manual";
}

export function normalizeWorkItemPriority(value: unknown): WorkItemPriority {
  return WORK_ITEM_PRIORITIES.includes(value as WorkItemPriority)
    ? (value as WorkItemPriority)
    : "medium";
}

// Stage is loose-coupled to columns (slug-derived). Accept any non-empty string,
// fall back to "backlog" when missing or empty. The previous strict whitelist
// rejected user-configured columns like "Doing"/"Blocked"/"Live".
export function normalizeWorkItemStage(value: unknown): WorkItemStage {
  if (typeof value !== "string" || !value.trim()) return "backlog";
  return value.trim() as WorkItemStage;
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length ? clean : null;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function rowToWorkItem(row: GrowthWorkItemRow): GrowthWorkItem {
  return {
    id: row.id,
    userEmail: row.user_email,
    title: row.title,
    description: row.description,
    itemType: normalizeWorkItemType(row.item_type),
    stage: normalizeWorkItemStage(row.stage),
    columnId: row.column_id,
    position: row.position ?? 0,
    source: normalizeWorkItemSource(row.source),
    sourceRef: row.source_ref,
    priority: normalizeWorkItemPriority(row.priority),
    link: row.link,
    dueAt: row.due_at,
    payload: normalizePayload(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List all work items (shared board — no user_email filter).
 */
export async function listWorkItems(
  client: SupabaseClient,
  _userEmail?: string,
): Promise<GrowthWorkItem[]> {
  const { data, error } = await client
    .from("growth_work_items")
    .select("*")
    .order("position", { ascending: true })
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`Error loading kanban items: ${error.message}`);
  }

  return ((data ?? []) as GrowthWorkItemRow[]).map(rowToWorkItem);
}

export async function createWorkItem(
  client: SupabaseClient,
  userEmail: string,
  input: CreateWorkItemInput,
): Promise<GrowthWorkItem> {
  const title = sanitizeText(input.title);
  if (!title) {
    throw new Error("Title is required.");
  }

  const row: Record<string, unknown> = {
    user_email: userEmail,
    title,
    description: sanitizeText(input.description),
    item_type: normalizeWorkItemType(input.itemType),
    stage: normalizeWorkItemStage(input.stage),
    source: normalizeWorkItemSource(input.source),
    source_ref: sanitizeText(input.sourceRef),
    priority: normalizeWorkItemPriority(input.priority),
    link: sanitizeText(input.link),
    due_at: normalizeDate(input.dueAt),
    payload: normalizePayload(input.payload),
  };

  if (input.columnId) {
    row.column_id = input.columnId;
  }

  const { data, error } = await client
    .from("growth_work_items")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Error creating kanban item: ${error.message}`);
  }

  return rowToWorkItem(data as GrowthWorkItemRow);
}

/**
 * Update a work item. Any authenticated user can update any card (shared board).
 */
export async function updateWorkItem(
  client: SupabaseClient,
  _userEmail: string,
  itemId: string,
  updates: UpdateWorkItemInput,
): Promise<GrowthWorkItem> {
  const patch: Record<string, unknown> = {};

  if (typeof updates.title !== "undefined") {
    const title = sanitizeText(updates.title);
    if (!title) {
      throw new Error("Title cannot be empty.");
    }
    patch.title = title;
  }

  if (typeof updates.description !== "undefined") {
    patch.description = sanitizeText(updates.description);
  }
  if (typeof updates.itemType !== "undefined") {
    patch.item_type = normalizeWorkItemType(updates.itemType);
  }
  if (typeof updates.stage !== "undefined") {
    patch.stage = normalizeWorkItemStage(updates.stage);
  }
  if (typeof updates.columnId !== "undefined") {
    patch.column_id = updates.columnId;
  }
  if (typeof updates.source !== "undefined") {
    patch.source = normalizeWorkItemSource(updates.source);
  }
  if (typeof updates.sourceRef !== "undefined") {
    patch.source_ref = sanitizeText(updates.sourceRef);
  }
  if (typeof updates.priority !== "undefined") {
    patch.priority = normalizeWorkItemPriority(updates.priority);
  }
  if (typeof updates.link !== "undefined") {
    patch.link = sanitizeText(updates.link);
  }
  if (typeof updates.dueAt !== "undefined") {
    patch.due_at = normalizeDate(updates.dueAt);
  }
  if (typeof updates.payload !== "undefined") {
    patch.payload = normalizePayload(updates.payload);
  }

  if (!Object.keys(patch).length) {
    throw new Error("No valid updates provided.");
  }

  const { data, error } = await client
    .from("growth_work_items")
    .update(patch)
    .eq("id", itemId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Error updating kanban item: ${error.message}`);
  }

  return rowToWorkItem(data as GrowthWorkItemRow);
}

/**
 * Delete a work item by id (shared board — any authenticated user can delete).
 */
export async function deleteWorkItem(
  client: SupabaseClient,
  itemId: string,
): Promise<void> {
  const { error } = await client
    .from("growth_work_items")
    .delete()
    .eq("id", itemId);

  if (error) {
    throw new Error(`Error deleting kanban item: ${error.message}`);
  }
}

export async function listExistingSourceRefs(
  client: SupabaseClient,
  userEmail: string,
  sourceRefs: string[],
): Promise<Set<string>> {
  const cleanRefs = sourceRefs.map((value) => value.trim()).filter(Boolean);
  if (!cleanRefs.length) {
    return new Set();
  }

  const { data, error } = await client
    .from("growth_work_items")
    .select("source_ref")
    .eq("user_email", userEmail)
    .in("source_ref", cleanRefs);

  if (error) {
    throw new Error(`Error loading existing source refs: ${error.message}`);
  }

  return new Set(
    (data ?? [])
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { source_ref?: unknown }).source_ref
          : null,
      )
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

export async function createWorkItemsBatch(
  client: SupabaseClient,
  userEmail: string,
  rows: CreateWorkItemInput[],
): Promise<GrowthWorkItem[]> {
  if (!rows.length) {
    return [];
  }

  const inserts = rows
    .map((input) => {
      const title = sanitizeText(input.title);
      if (!title) return null;
      return {
        user_email: userEmail,
        title,
        description: sanitizeText(input.description),
        item_type: normalizeWorkItemType(input.itemType),
        stage: normalizeWorkItemStage(input.stage),
        source: normalizeWorkItemSource(input.source),
        source_ref: sanitizeText(input.sourceRef),
        priority: normalizeWorkItemPriority(input.priority),
        link: sanitizeText(input.link),
        due_at: normalizeDate(input.dueAt),
        payload: normalizePayload(input.payload),
      };
    })
    .filter(Boolean);

  if (!inserts.length) {
    return [];
  }

  const { data, error } = await client
    .from("growth_work_items")
    .insert(inserts)
    .select("*");

  if (error) {
    throw new Error(`Error inserting kanban items: ${error.message}`);
  }

  return ((data ?? []) as GrowthWorkItemRow[]).map(rowToWorkItem);
}
