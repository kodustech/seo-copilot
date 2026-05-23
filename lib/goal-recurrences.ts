import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createGoal,
  currentMonthRange,
  currentWeekRange,
  type Goal,
  type GoalKind,
  type GoalPriority,
} from "@/lib/goals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A recurrence is the *rule* ("10 reddit comments every week"). The cron
// materializer turns each active rule into one concrete `goals` row per
// period, so each week keeps its own attainment history.
export type GoalCadence = "weekly" | "monthly";

export const GOAL_CADENCES: GoalCadence[] = ["weekly", "monthly"];

export type GoalRecurrence = {
  id: string;
  title: string;
  description: string | null;
  unit: string | null;
  kind: GoalKind;
  targetCount: number;
  priority: GoalPriority;
  cadence: GoalCadence;
  active: boolean;
  responsibleEmail: string | null;
  projectRef: string | null;
  notes: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRecurrenceInput = {
  title: string;
  description?: string | null;
  unit?: string | null;
  kind?: GoalKind;
  targetCount?: number;
  priority?: GoalPriority;
  cadence: GoalCadence;
  active?: boolean;
  responsibleEmail?: string | null;
  projectRef?: string | null;
  notes?: string | null;
  createdByEmail?: string | null;
};

export type UpdateRecurrenceInput = Partial<
  Omit<CreateRecurrenceInput, "createdByEmail">
>;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  title: string;
  description: string | null;
  unit: string | null;
  kind: GoalKind;
  target_count: number;
  priority: GoalPriority;
  cadence: GoalCadence;
  active: boolean;
  responsible_email: string | null;
  project_ref: string | null;
  notes: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

function rowToRecurrence(row: Row): GoalRecurrence {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    unit: row.unit,
    kind: row.kind ?? "output",
    targetCount: row.target_count,
    priority: row.priority,
    cadence: row.cadence,
    active: row.active,
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

// Period (YYYY-MM-DD start/end) a cadence resolves to for a given moment.
export function periodForCadence(
  cadence: GoalCadence,
  ref: Date = new Date(),
): { start: string; end: string } {
  return cadence === "weekly" ? currentWeekRange(ref) : currentMonthRange(ref);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listRecurrences(
  client: SupabaseClient,
  filters: { active?: boolean } = {},
): Promise<GoalRecurrence[]> {
  let query = client
    .from("goal_recurrences")
    .select("*")
    .order("created_at", { ascending: false });

  if (typeof filters.active === "boolean") {
    query = query.eq("active", filters.active);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list recurrences: ${error.message}`);
  return (data ?? []).map((row) => rowToRecurrence(row as Row));
}

export async function createRecurrence(
  client: SupabaseClient,
  input: CreateRecurrenceInput,
): Promise<GoalRecurrence> {
  if (!input.title?.trim()) throw new Error("title is required");
  if (input.cadence !== "weekly" && input.cadence !== "monthly") {
    throw new Error("cadence must be 'weekly' or 'monthly'");
  }

  const row = {
    title: input.title.trim(),
    description: trimOrNull(input.description),
    unit: trimOrNull(input.unit),
    kind: input.kind ?? "output",
    target_count: input.targetCount ?? 1,
    priority: input.priority ?? "medium",
    cadence: input.cadence,
    active: input.active ?? true,
    responsible_email: trimOrNull(input.responsibleEmail),
    project_ref: trimOrNull(input.projectRef),
    notes: trimOrNull(input.notes),
    created_by_email: trimOrNull(input.createdByEmail),
  };

  const { data, error } = await client
    .from("goal_recurrences")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create recurrence: ${error.message}`);
  return rowToRecurrence(data as Row);
}

export async function updateRecurrence(
  client: SupabaseClient,
  id: string,
  updates: UpdateRecurrenceInput,
): Promise<GoalRecurrence> {
  const patch: Record<string, unknown> = {};
  if ("title" in updates && updates.title !== undefined)
    patch.title = updates.title.trim();
  if ("description" in updates)
    patch.description = trimOrNull(updates.description ?? null);
  if ("unit" in updates) patch.unit = trimOrNull(updates.unit ?? null);
  if ("kind" in updates && updates.kind !== undefined) patch.kind = updates.kind;
  if ("targetCount" in updates && typeof updates.targetCount === "number")
    patch.target_count = updates.targetCount;
  if ("priority" in updates && updates.priority !== undefined)
    patch.priority = updates.priority;
  if ("cadence" in updates && updates.cadence !== undefined)
    patch.cadence = updates.cadence;
  if ("active" in updates && typeof updates.active === "boolean")
    patch.active = updates.active;
  if ("responsibleEmail" in updates)
    patch.responsible_email = trimOrNull(updates.responsibleEmail ?? null);
  if ("projectRef" in updates)
    patch.project_ref = trimOrNull(updates.projectRef ?? null);
  if ("notes" in updates) patch.notes = trimOrNull(updates.notes ?? null);

  const { data, error } = await client
    .from("goal_recurrences")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update recurrence: ${error.message}`);
  return rowToRecurrence(data as Row);
}

export async function deleteRecurrence(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  // goals.recurrence_id is ON DELETE SET NULL, so already-materialized
  // instances survive (just lose the link) when a rule is removed.
  const { error } = await client
    .from("goal_recurrences")
    .delete()
    .eq("id", id);
  if (error) throw new Error(`Failed to delete recurrence: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

// Create the goal instance for `rule`'s current period if one doesn't exist
// yet. Idempotent: the (recurrence_id, period_start) unique index means a
// duplicate insert is swallowed and we return null. Safe to call as often as
// the cron fires.
export async function materializeRecurrence(
  client: SupabaseClient,
  rule: GoalRecurrence,
  ref: Date = new Date(),
): Promise<Goal | null> {
  const { start, end } = periodForCadence(rule.cadence, ref);

  const { data: existing, error: readErr } = await client
    .from("goals")
    .select("id")
    .eq("recurrence_id", rule.id)
    .eq("period_start", start)
    .maybeSingle();
  if (readErr) {
    throw new Error(`Failed to check existing instance: ${readErr.message}`);
  }
  if (existing) return null;

  try {
    return await createGoal(client, {
      title: rule.title,
      description: rule.description,
      unit: rule.unit,
      kind: rule.kind,
      targetCount: rule.targetCount,
      periodStart: start,
      periodEnd: end,
      priority: rule.priority,
      responsibleEmail: rule.responsibleEmail,
      projectRef: rule.projectRef,
      notes: rule.notes,
      recurrenceId: rule.id,
      createdByEmail: rule.createdByEmail,
    });
  } catch (err) {
    // A racing cron tick may have inserted the same (rule, period) between our
    // read and write; the unique index rejects the dupe. Treat as no-op.
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique constraint/i.test(msg)) return null;
    throw err;
  }
}

// Materialize the current period for every active rule. Best-effort: a single
// rule's failure is logged and doesn't abort the rest. Returns a per-rule
// summary for the cron response.
export async function materializeDueRecurrences(
  client: SupabaseClient,
  ref: Date = new Date(),
): Promise<{ ruleId: string; created: boolean; error?: string }[]> {
  const rules = await listRecurrences(client, { active: true });
  const results: { ruleId: string; created: boolean; error?: string }[] = [];

  for (const rule of rules) {
    try {
      const goal = await materializeRecurrence(client, rule, ref);
      results.push({ ruleId: rule.id, created: goal !== null });
    } catch (err) {
      console.error(
        `[goal-recurrences] materialize failed for ${rule.id}:`,
        err instanceof Error ? err.message : err,
      );
      results.push({
        ruleId: rule.id,
        created: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return results;
}
