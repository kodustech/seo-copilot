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
const OPERATOR_SKILL_PAGE_SIZE = 200;
// Keep authoritative operator rules complete in their source of truth while
// bounding the amount of operator context sent to each model call.
const MAX_OPERATOR_SKILLS = 500;

export type SkillSource = "operator" | "agent" | "legacy";
export type PromptSkillContext = Record<SkillSource, string[]>;

export class SkillValidationError extends Error {}
export class SkillNotFoundError extends Error {}

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
): Promise<PromptSkillContext> {
  // Operator rules are authoritative and must not be truncated by the
  // learned-skill cap or PostgREST's default page size. The prompt still needs
  // a hard ceiling so a large persona cannot exhaust its model context.
  const operatorSkillsPromise = (async () => {
    const skills: { id: string; content: string; createdAt: string }[] = [];
    let lastId: string | null = null;
    const result = () =>
      skills
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, MAX_OPERATOR_SKILLS)
        .map((skill) => skill.content);
    while (true) {
      let query = client
        .from("persona_memory")
        .select("id,content,created_at")
        .eq("persona_id", personaId)
        .contains("tags", [SKILL_TAG, OPERATOR_TAG])
        .order("id", { ascending: true })
        .limit(OPERATOR_SKILL_PAGE_SIZE);
      if (lastId) query = query.gt("id", lastId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      if (!rows.length) return result();

      // Guard against a broken/mocked query that ignores the keyset filter.
      const nextId = String(rows.at(-1)?.id ?? "");
      if (!nextId || (lastId && nextId <= lastId)) {
        throw new Error("Operator skill pagination did not advance.");
      }
      skills.push(
        ...rows
          .filter((row) => typeof row.content === "string" && row.content.trim())
          .map((row) => ({
            id: String(row.id),
            content: String(row.content),
            createdAt: String(row.created_at),
          })),
      );
      if (rows.length < OPERATOR_SKILL_PAGE_SIZE) return result();
      lastId = nextId;
    }
  })();

  const [operator, agentResult, legacyResult] = await Promise.all([
    operatorSkillsPromise,
    client
      .from("persona_memory")
      .select("content,tags,created_at")
      .eq("persona_id", personaId)
      .contains("tags", [SKILL_TAG, AGENT_TAG])
      .not("tags", "cs", `{${OPERATOR_TAG}}`)
      .order("created_at", { ascending: false })
      .limit(limit),
    client
      .from("persona_memory")
      .select("content,tags,created_at")
      .eq("persona_id", personaId)
      .contains("tags", [SKILL_TAG])
      .not("tags", "cs", `{${OPERATOR_TAG}}`)
      .not("tags", "cs", `{${AGENT_TAG}}`)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  if (agentResult.error) throw new Error(agentResult.error.message);
  if (legacyResult.error) throw new Error(legacyResult.error.message);
  const content = (rows: { content: unknown }[]) =>
    rows
      .filter((row) => typeof row.content === "string" && row.content.trim())
      .map((row) => String(row.content));
  return {
    operator,
    legacy: content(legacyResult.data ?? []),
    agent: content(agentResult.data ?? []),
  };
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
  if (trimmed.length < 3) throw new SkillValidationError("A rule needs at least a few words.");
  const { data, error } = await client
    .from("persona_memory")
    .update({
      title: trimmed.slice(0, 80),
      content: trimmed,
      tags: [SKILL_TAG, source],
    })
    .eq("id", skillId)
    .eq("persona_id", personaId)
    .contains("tags", [SKILL_TAG])
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new SkillNotFoundError("This rule no longer exists. Refresh and try again.");
}

export async function addSkill(
  client: SupabaseClient,
  personaId: string,
  skill: string,
  source: Exclude<SkillSource, "legacy"> = "agent",
): Promise<MemoryNote> {
  const trimmed = skill.trim();
  return saveMemory(client, personaId, {
    title: trimmed.slice(0, 80),
    content: trimmed,
    tags: [SKILL_TAG, source],
  });
}
