import type { SupabaseClient } from "@supabase/supabase-js";

export type WorkItemType = "idea" | "keyword" | "title" | "article" | "social";
export type WorkItemSource = "manual" | "blog" | "changelog" | "agent" | "n8n";
export type WorkItemPriority = "low" | "medium" | "high";
export type WorkItemStage =
  | "backlog"
  | "research"
  | "seo_ready"
  | "drafting"
  | "review"
  | "scheduled"
  | "published";

export type StageDefinition = {
  id: WorkItemStage;
  label: string;
  help: string;
};

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
];

export const WORK_ITEM_SOURCES: WorkItemSource[] = [
  "manual",
  "blog",
  "changelog",
  "agent",
  "n8n",
];

export const WORK_ITEM_PRIORITIES: WorkItemPriority[] = ["low", "medium", "high"];

export type GrowthWorkItem = {
  id: string;
  userEmail: string;
  title: string;
  description: string | null;
  itemType: WorkItemType;
  stage: WorkItemStage;
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

export function normalizeWorkItemStage(value: unknown): WorkItemStage {
  const stage = value as WorkItemStage;
  return KANBAN_STAGES.some((item) => item.id === stage) ? stage : "backlog";
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

export async function listWorkItems(
  client: SupabaseClient,
  userEmail: string,
): Promise<GrowthWorkItem[]> {
  const { data, error } = await client
    .from("growth_work_items")
    .select("*")
    .eq("user_email", userEmail)
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

  const row = {
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

export async function updateWorkItem(
  client: SupabaseClient,
  userEmail: string,
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
    .eq("user_email", userEmail)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Error updating kanban item: ${error.message}`);
  }

  return rowToWorkItem(data as GrowthWorkItemRow);
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
