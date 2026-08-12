import type { SupabaseClient } from "@supabase/supabase-js";

export type SessionTrigger = "manual" | "scheduled" | "reactive";
export type SessionStatus = "running" | "completed" | "failed";
export type StepKind = "tool_call" | "tool_result" | "message" | "error";

export type PersonaSession = {
  id: string;
  persona_id: string;
  trigger: SessionTrigger;
  goal: string;
  status: SessionStatus;
  model_provider: string | null;
  model_name: string | null;
  result_summary: string | null;
  error: string | null;
  created_by: string;
  started_at: string;
  finished_at: string | null;
};

export type PersonaSessionStep = {
  id: string;
  session_id: string;
  idx: number;
  kind: StepKind;
  tool: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

type Row = Record<string, unknown>;

function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asNullable(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function rowToSession(row: Row): PersonaSession {
  return {
    id: asText(row.id),
    persona_id: asText(row.persona_id),
    trigger: (row.trigger as SessionTrigger) ?? "manual",
    goal: asText(row.goal),
    status: (row.status as SessionStatus) ?? "running",
    model_provider: asNullable(row.model_provider),
    model_name: asNullable(row.model_name),
    result_summary: asNullable(row.result_summary),
    error: asNullable(row.error),
    created_by: asText(row.created_by),
    started_at: asText(row.started_at),
    finished_at: asNullable(row.finished_at),
  };
}

function rowToStep(row: Row): PersonaSessionStep {
  return {
    id: asText(row.id),
    session_id: asText(row.session_id),
    idx: Number(row.idx ?? 0),
    kind: (row.kind as StepKind) ?? "message",
    tool: asNullable(row.tool),
    payload: asRecord(row.payload),
    created_at: asText(row.created_at),
  };
}

export async function createSession(
  client: SupabaseClient,
  input: {
    persona_id: string;
    trigger: SessionTrigger;
    goal: string;
    model_provider?: string | null;
    model_name?: string | null;
    created_by?: string;
  },
): Promise<PersonaSession> {
  const { data, error } = await client
    .from("persona_sessions")
    .insert({
      persona_id: input.persona_id,
      trigger: input.trigger,
      goal: input.goal,
      model_provider: input.model_provider ?? null,
      model_name: input.model_name ?? null,
      created_by: input.created_by ?? "",
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToSession(data);
}

export async function recordStep(
  client: SupabaseClient,
  sessionId: string,
  idx: number,
  step: { kind: StepKind; tool?: string | null; payload?: Record<string, unknown> },
): Promise<void> {
  const { error } = await client.from("persona_session_steps").insert({
    session_id: sessionId,
    idx,
    kind: step.kind,
    tool: step.tool ?? null,
    payload: step.payload ?? {},
  });
  if (error) throw new Error(error.message);
}

export async function finishSession(
  client: SupabaseClient,
  sessionId: string,
  patch: { status: SessionStatus; result_summary?: string | null; error?: string | null },
): Promise<void> {
  const { error } = await client
    .from("persona_sessions")
    .update({
      status: patch.status,
      result_summary: patch.result_summary ?? null,
      error: patch.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw new Error(error.message);
}

export async function listSessions(
  client: SupabaseClient,
  personaId: string,
  limit = 50,
): Promise<PersonaSession[]> {
  const { data, error } = await client
    .from("persona_sessions")
    .select("*")
    .eq("persona_id", personaId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToSession);
}

export async function getSessionWithSteps(
  client: SupabaseClient,
  sessionId: string,
): Promise<{ session: PersonaSession; steps: PersonaSessionStep[] } | null> {
  const { data: sessionRow, error: sessionErr } = await client
    .from("persona_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionErr) throw new Error(sessionErr.message);
  if (!sessionRow) return null;

  const { data: stepRows, error: stepErr } = await client
    .from("persona_session_steps")
    .select("*")
    .eq("session_id", sessionId)
    .order("idx", { ascending: true });
  if (stepErr) throw new Error(stepErr.message);

  return {
    session: rowToSession(sessionRow),
    steps: (stepRows ?? []).map(rowToStep),
  };
}
