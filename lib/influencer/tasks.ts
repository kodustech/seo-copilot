import type { SupabaseClient } from "@supabase/supabase-js";

export type TaskKind =
  | "post"
  | "article"
  | "reply"
  | "benchmark"
  | "site_update"
  | "email"
  | "research"
  | "other";

export type TaskStatus =
  | "planned"
  | "doing"
  | "done"
  | "failed"
  | "cancelled";

export type PersonaTask = {
  id: string;
  persona_id: string;
  kind: TaskKind;
  channel_platform: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  scheduled_for: string;
  session_id: string | null;
  result_summary: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const TASK_KINDS: ReadonlySet<TaskKind> = new Set([
  "post",
  "article",
  "reply",
  "benchmark",
  "site_update",
  "email",
  "research",
  "other",
]);

export function normalizeTaskKind(value: unknown): TaskKind {
  return TASK_KINDS.has(value as TaskKind) ? (value as TaskKind) : "other";
}

type Row = Record<string, unknown>;
const asText = (v: unknown) => (typeof v === "string" ? v : "");
const asNull = (v: unknown) => (typeof v === "string" && v.length ? v : null);

export function rowToTask(row: Row): PersonaTask {
  return {
    id: asText(row.id),
    persona_id: asText(row.persona_id),
    kind: normalizeTaskKind(row.kind),
    channel_platform: asNull(row.channel_platform),
    title: asText(row.title),
    goal: asText(row.goal),
    status: (row.status as TaskStatus) ?? "planned",
    scheduled_for: asText(row.scheduled_for),
    session_id: asNull(row.session_id),
    result_summary: asNull(row.result_summary),
    error: asNull(row.error),
    created_by: asText(row.created_by),
    created_at: asText(row.created_at),
    updated_at: asText(row.updated_at),
  };
}

export type NewTask = {
  kind: TaskKind;
  channel_platform?: string | null;
  title: string;
  goal: string;
  scheduled_for?: string | null;
  created_by?: string;
};

export async function insertTasks(
  client: SupabaseClient,
  personaId: string,
  tasks: NewTask[],
): Promise<PersonaTask[]> {
  if (!tasks.length) return [];
  const { data, error } = await client
    .from("persona_tasks")
    .insert(
      tasks.map((t) => ({
        persona_id: personaId,
        kind: t.kind,
        channel_platform: t.channel_platform ?? null,
        title: t.title,
        goal: t.goal,
        scheduled_for: t.scheduled_for ?? new Date().toISOString(),
        created_by: t.created_by ?? "planner",
      })),
    )
    .select();
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToTask);
}

export async function listTasks(
  client: SupabaseClient,
  personaId: string,
  filters: { statuses?: TaskStatus[]; limit?: number } = {},
): Promise<PersonaTask[]> {
  let q = client
    .from("persona_tasks")
    .select("*")
    .eq("persona_id", personaId)
    .order("scheduled_for", { ascending: true })
    .limit(Math.min(Math.max(filters.limit ?? 100, 1), 500));
  if (filters.statuses?.length) q = q.in("status", filters.statuses);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToTask);
}

/** Open (still-relevant) tasks, for the planner to avoid duplicating work. */
export async function listOpenTasks(
  client: SupabaseClient,
  personaId: string,
): Promise<PersonaTask[]> {
  return listTasks(client, personaId, { statuses: ["planned", "doing"], limit: 100 });
}

/** Due tasks across the fleet: planned and scheduled_for has arrived. */
export async function listDueTasks(
  client: SupabaseClient,
  nowIso: string,
  limit = 25,
): Promise<PersonaTask[]> {
  const { data, error } = await client
    .from("persona_tasks")
    .select("*")
    .eq("status", "planned")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToTask);
}

/** Atomically claim a task for execution (planned → doing). */
export async function claimTask(
  client: SupabaseClient,
  id: string,
): Promise<PersonaTask | null> {
  const { data, error } = await client
    .from("persona_tasks")
    .update({ status: "doing" })
    .eq("id", id)
    .eq("status", "planned")
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToTask(data) : null;
}

export async function finishTask(
  client: SupabaseClient,
  id: string,
  patch: {
    status: TaskStatus;
    session_id?: string | null;
    result_summary?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const { error } = await client
    .from("persona_tasks")
    .update({
      status: patch.status,
      session_id: patch.session_id ?? null,
      result_summary: patch.result_summary ?? null,
      error: patch.error ?? null,
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

/** Recover tasks stuck in `doing` after a crash (older than cutoff → failed). */
export async function resetStaleTasks(
  client: SupabaseClient,
  cutoffIso: string,
): Promise<number> {
  const { data, error } = await client
    .from("persona_tasks")
    .update({ status: "failed", error: "Interrupted (stale task reset)." })
    .eq("status", "doing")
    .lte("updated_at", cutoffIso)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
