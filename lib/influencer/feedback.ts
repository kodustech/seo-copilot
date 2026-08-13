/**
 * Operator feedback for a persona + the durable "skills" it distills from that
 * feedback. Feedback lives in its own table (the operator writes, the shift
 * reads and marks applied). Skills are memory notes tagged "skill" — always-on
 * learnings injected into every shift, reusing persona_memory so there's no
 * extra table and no content_config write race.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { saveMemory, type MemoryNote } from "@/lib/influencer/memory";

export type Feedback = {
  id: string;
  body: string;
  status: "new" | "applied";
  created_by: string | null;
  created_at: string;
};

function rowToFeedback(row: Record<string, unknown>): Feedback {
  return {
    id: typeof row.id === "string" ? row.id : "",
    body: typeof row.body === "string" ? row.body : "",
    status: row.status === "applied" ? "applied" : "new",
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

export async function addFeedback(
  client: SupabaseClient,
  personaId: string,
  body: string,
  createdBy: string | null,
): Promise<Feedback> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Feedback can't be empty.");
  const { data, error } = await client
    .from("persona_feedback")
    .insert({ persona_id: personaId, body: trimmed, created_by: createdBy })
    .select("id,body,status,created_by,created_at")
    .single();
  if (error) throw new Error(error.message);
  return rowToFeedback(data);
}

export async function listNewFeedback(
  client: SupabaseClient,
  personaId: string,
  limit = 10,
): Promise<Feedback[]> {
  const { data, error } = await client
    .from("persona_feedback")
    .select("id,body,status,created_by,created_at")
    .eq("persona_id", personaId)
    .eq("status", "new")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToFeedback);
}

export async function listFeedback(
  client: SupabaseClient,
  personaId: string,
  limit = 20,
): Promise<Feedback[]> {
  const { data, error } = await client
    .from("persona_feedback")
    .select("id,body,status,created_by,created_at")
    .eq("persona_id", personaId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToFeedback);
}

export async function markFeedbackApplied(
  client: SupabaseClient,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const { error } = await client
    .from("persona_feedback")
    .update({ status: "applied", applied_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(error.message);
}

const SKILL_TAG = "skill";

/** Durable learnings the persona always applies (memory notes tagged "skill"). */
export async function listSkills(
  client: SupabaseClient,
  personaId: string,
  limit = 30,
): Promise<string[]> {
  const { data, error } = await client
    .from("persona_memory")
    .select("content,created_at")
    .eq("persona_id", personaId)
    .contains("tags", [SKILL_TAG])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((r) => (typeof r.content === "string" ? r.content : ""))
    .filter(Boolean);
}

export async function addSkill(
  client: SupabaseClient,
  personaId: string,
  skill: string,
): Promise<MemoryNote> {
  return saveMemory(client, personaId, {
    title: skill.slice(0, 80),
    content: skill,
    tags: [SKILL_TAG],
  });
}
