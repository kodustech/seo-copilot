import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalStatus =
  | "active"
  | "completed"
  | "missed"
  | "paused"
  | "archived";

export type GoalPriority = "high" | "medium" | "low";

export const GOAL_STATUSES: GoalStatus[] = [
  "active",
  "completed",
  "missed",
  "paused",
  "archived",
];

export const GOAL_PRIORITIES: GoalPriority[] = ["high", "medium", "low"];

export type Goal = {
  id: string;
  title: string;
  description: string | null;
  unit: string | null;
  targetCount: number;
  currentCount: number;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  status: GoalStatus;
  priority: GoalPriority;
  responsibleEmail: string | null;
  projectRef: string | null;
  notes: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateGoalInput = {
  title: string;
  description?: string | null;
  unit?: string | null;
  targetCount?: number;
  currentCount?: number;
  periodStart: string;
  periodEnd: string;
  status?: GoalStatus;
  priority?: GoalPriority;
  responsibleEmail?: string | null;
  projectRef?: string | null;
  notes?: string | null;
  createdByEmail?: string | null;
};

export type UpdateGoalInput = Partial<
  Omit<CreateGoalInput, "createdByEmail">
>;

export type GoalFilters = {
  status?: GoalStatus | GoalStatus[];
  responsibleEmail?: string;
  // "current": goals whose period contains today
  // "upcoming": period_start > today
  // "past": period_end < today
  // "all": no period filter
  periodScope?: "current" | "upcoming" | "past" | "all";
  limit?: number;
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

// Returns ISO date strings (YYYY-MM-DD) for the Mon-Sun week containing
// `ref` (default = today). Week starts Monday for sane growth-ops cadence.
export function currentWeekRange(ref: Date = new Date()): {
  start: string;
  end: string;
} {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  // 0 = Sunday in JS; shift so Monday is 0
  const dow = (d.getDay() + 6) % 7;
  const start = new Date(d);
  start.setDate(d.getDate() - dow);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export function currentMonthRange(ref: Date = new Date()): {
  start: string;
  end: string;
} {
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  title: string;
  description: string | null;
  unit: string | null;
  target_count: number;
  current_count: number;
  period_start: string;
  period_end: string;
  status: GoalStatus;
  priority: GoalPriority;
  responsible_email: string | null;
  project_ref: string | null;
  notes: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

function rowToGoal(row: Row): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    unit: row.unit,
    targetCount: row.target_count,
    currentCount: row.current_count,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    priority: row.priority,
    responsibleEmail: row.responsible_email,
    projectRef: row.project_ref,
    notes: row.notes,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listGoals(
  client: SupabaseClient,
  filters: GoalFilters = {},
): Promise<Goal[]> {
  let query = client
    .from("goals")
    .select("*")
    .order("priority", { ascending: true })
    .order("period_end", { ascending: true });

  if (filters.status) {
    if (Array.isArray(filters.status)) {
      query = query.in("status", filters.status);
    } else {
      query = query.eq("status", filters.status);
    }
  }
  if (filters.responsibleEmail) {
    query = query.eq("responsible_email", filters.responsibleEmail);
  }

  const today = new Date().toISOString().slice(0, 10);
  const scope = filters.periodScope ?? "current";
  if (scope === "current") {
    query = query.lte("period_start", today).gte("period_end", today);
  } else if (scope === "upcoming") {
    query = query.gt("period_start", today);
  } else if (scope === "past") {
    query = query.lt("period_end", today);
  }
  // "all": no period filter

  if (filters.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list goals: ${error.message}`);
  return (data ?? []).map((row) => rowToGoal(row as Row));
}

export async function createGoal(
  client: SupabaseClient,
  input: CreateGoalInput,
): Promise<Goal> {
  if (!input.title?.trim()) throw new Error("title is required");
  if (!input.periodStart || !input.periodEnd) {
    throw new Error("periodStart and periodEnd are required");
  }

  const row = {
    title: input.title.trim(),
    description: trimOrNull(input.description),
    unit: trimOrNull(input.unit),
    target_count: input.targetCount ?? 1,
    current_count: input.currentCount ?? 0,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    status: input.status ?? "active",
    priority: input.priority ?? "medium",
    responsible_email: trimOrNull(input.responsibleEmail),
    project_ref: trimOrNull(input.projectRef),
    notes: trimOrNull(input.notes),
    created_by_email: trimOrNull(input.createdByEmail),
  };

  const { data, error } = await client
    .from("goals")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create goal: ${error.message}`);
  return rowToGoal(data as Row);
}

export async function updateGoal(
  client: SupabaseClient,
  id: string,
  updates: UpdateGoalInput,
): Promise<Goal> {
  const patch: Record<string, unknown> = {};
  if ("title" in updates && updates.title !== undefined)
    patch.title = updates.title.trim();
  if ("description" in updates)
    patch.description = trimOrNull(updates.description ?? null);
  if ("unit" in updates) patch.unit = trimOrNull(updates.unit ?? null);
  if ("targetCount" in updates && typeof updates.targetCount === "number")
    patch.target_count = updates.targetCount;
  if ("currentCount" in updates && typeof updates.currentCount === "number")
    patch.current_count = updates.currentCount;
  if ("periodStart" in updates && updates.periodStart !== undefined)
    patch.period_start = updates.periodStart;
  if ("periodEnd" in updates && updates.periodEnd !== undefined)
    patch.period_end = updates.periodEnd;
  if ("status" in updates && updates.status !== undefined)
    patch.status = updates.status;
  if ("priority" in updates && updates.priority !== undefined)
    patch.priority = updates.priority;
  if ("responsibleEmail" in updates)
    patch.responsible_email = trimOrNull(updates.responsibleEmail ?? null);
  if ("projectRef" in updates)
    patch.project_ref = trimOrNull(updates.projectRef ?? null);
  if ("notes" in updates) patch.notes = trimOrNull(updates.notes ?? null);

  const { data, error } = await client
    .from("goals")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update goal: ${error.message}`);
  return rowToGoal(data as Row);
}

// Increment current_count and auto-flip to "completed" once it reaches the
// target. Server-side so the math stays consistent across clients.
export async function incrementGoalProgress(
  client: SupabaseClient,
  id: string,
  delta: number,
): Promise<Goal> {
  const { data: existing, error: readErr } = await client
    .from("goals")
    .select("*")
    .eq("id", id)
    .single();
  if (readErr || !existing) {
    throw new Error(readErr?.message || "Goal not found");
  }
  const current = (existing as Row).current_count + delta;
  const target = (existing as Row).target_count;
  const newStatus: GoalStatus =
    current >= target && (existing as Row).status === "active"
      ? "completed"
      : current < target && (existing as Row).status === "completed"
        ? "active"
        : (existing as Row).status;

  return updateGoal(client, id, {
    currentCount: Math.max(0, current),
    status: newStatus,
  });
}

export async function deleteGoal(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("goals").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete goal: ${error.message}`);
}

export async function getGoalStats(
  client: SupabaseClient,
): Promise<{ total: number; byStatus: Record<string, number> }> {
  const { data, error } = await client.from("goals").select("status");
  if (error) throw new Error(`Failed to get goal stats: ${error.message}`);
  const byStatus: Record<string, number> = {};
  for (const row of (data ?? []) as { status: string }[]) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }
  return { total: (data ?? []).length, byStatus };
}
