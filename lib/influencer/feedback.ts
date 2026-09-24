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
const OPERATOR_TAG = "operator";
const AGENT_TAG = "agent";
export const MAX_SKILL_LENGTH = 1000;

export type SkillSource = "operator" | "agent" | "legacy";

function skillSource(tags: unknown): SkillSource {
  if (Array.isArray(tags) && tags.includes(OPERATOR_TAG)) return "operator";
  if (Array.isArray(tags) && tags.includes(AGENT_TAG)) return "agent";
  return "legacy";
}

/** Durable learnings the persona always applies (memory notes tagged "skill"). */
export async function listSkills(
  client: SupabaseClient,
  personaId: string,
  limit = 30,
): Promise<string[]> {
  const [operatorResult, automaticResult] = await Promise.all([
    client
      .from("persona_memory")
      .select("content,tags,created_at")
      .eq("persona_id", personaId)
      .contains("tags", [SKILL_TAG, OPERATOR_TAG])
      .order("created_at", { ascending: false }),
    client
      .from("persona_memory")
      .select("content,tags,created_at")
      .eq("persona_id", personaId)
      .contains("tags", [SKILL_TAG])
      .not("tags", "cs", `{${OPERATOR_TAG}}`)
      .order("created_at", { ascending: false })
      // Keep the automatic read bounded without capping operator rules.
      .limit(Math.max(limit * 4, 200)),
  ]);
  if (operatorResult.error) throw new Error(operatorResult.error.message);
  if (automaticResult.error) throw new Error(automaticResult.error.message);
  const operatorRows = (operatorResult.data ?? []).filter((r) => typeof r.content === "string" && r.content.trim());
  const automaticRows = (automaticResult.data ?? [])
    .filter((r) => skillSource(r.tags) !== "operator")
    .filter((r) => typeof r.content === "string" && r.content.trim());
  const rows = [...operatorRows, ...automaticRows];
  const protectedSkills = rows.filter((r) => skillSource(r.tags) === "operator");
  const legacySkills = rows.filter((r) => skillSource(r.tags) === "legacy").slice(0, limit);
  const learnedSkills = rows.filter((r) => skillSource(r.tags) === "agent").slice(0, limit);
  return [...protectedSkills, ...legacySkills, ...learnedSkills].map((r) => String(r.content));
}

/** The same skills, with ids, for anything that needs to remove one. The agent
 *  path keeps using listSkills: it reads rules, it does not manage them. */
export async function listSkillNotes(
  client: SupabaseClient,
  personaId: string,
  limit = 1000,
): Promise<{ id: string; content: string; source: SkillSource }[]> {
  const { data, error } = await client
    .from("persona_memory")
    .select("id,content,tags,created_at")
    .eq("persona_id", personaId)
    .contains("tags", [SKILL_TAG])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((r) => typeof r.content === "string" && r.content.trim())
    .map((r) => ({ id: String(r.id), content: String(r.content), source: skillSource(r.tags) }));
}

/** Remove one skill. Scoped by persona as well as id, so a stale id from another
 *  persona's list cannot delete across personas. */
export async function removeSkill(
  client: SupabaseClient,
  personaId: string,
  skillId: string,
): Promise<void> {
  const { error } = await client
    .from("persona_memory")
    .delete()
    .eq("id", skillId)
    .eq("persona_id", personaId)
    .contains("tags", [SKILL_TAG]);
  if (error) throw new Error(error.message);
}

/** Update one existing skill without changing its identity. */
export async function updateSkill(
  client: SupabaseClient,
  personaId: string,
  skillId: string,
  skill: string,
  source: SkillSource,
): Promise<void> {
  const trimmed = skill.trim();
  if (trimmed.length < 3) throw new Error("A rule needs at least a few words.");
  if (trimmed.length > MAX_SKILL_LENGTH) {
    throw new Error(`A rule cannot exceed ${MAX_SKILL_LENGTH} characters.`);
  }
  const { error } = await client
    .from("persona_memory")
    .update({
      title: trimmed.slice(0, 80),
      content: trimmed,
      tags: [SKILL_TAG, source],
    })
    .eq("id", skillId)
    .eq("persona_id", personaId)
    .contains("tags", [SKILL_TAG]);
  if (error) throw new Error(error.message);
}

export async function addSkill(
  client: SupabaseClient,
  personaId: string,
  skill: string,
  source: Exclude<SkillSource, "legacy"> = "agent",
): Promise<MemoryNote> {
  const trimmed = skill.trim().slice(0, MAX_SKILL_LENGTH);
  return saveMemory(client, personaId, {
    title: trimmed.slice(0, 80),
    content: trimmed,
    tags: [SKILL_TAG, source],
  });
}
