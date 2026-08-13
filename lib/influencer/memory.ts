/**
 * Persona memory: durable notes/studies a persona writes for itself and reads
 * back on later shifts. Keeps it from re-researching the same thing and lets it
 * build a point of view over time. Keyword search for now (no embeddings).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type MemoryNote = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
};

function rowToNote(row: Record<string, unknown>): MemoryNote {
  return {
    id: typeof row.id === "string" ? row.id : "",
    title: typeof row.title === "string" ? row.title : "",
    content: typeof row.content === "string" ? row.content : "",
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [],
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

export async function saveMemory(
  client: SupabaseClient,
  personaId: string,
  input: { title: string; content: string; tags?: string[] },
): Promise<MemoryNote> {
  const { data, error } = await client
    .from("persona_memory")
    .insert({
      persona_id: personaId,
      title: input.title.slice(0, 200),
      content: input.content,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 12),
      created_by: "agent",
    })
    .select("id,title,content,tags,created_at")
    .single();
  if (error) throw new Error(error.message);
  return rowToNote(data);
}

export async function searchMemory(
  client: SupabaseClient,
  personaId: string,
  query: string,
  limit = 5,
): Promise<MemoryNote[]> {
  const q = query.trim();
  let builder = client
    .from("persona_memory")
    .select("id,title,content,tags,created_at")
    .eq("persona_id", personaId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 20));
  // Strip every PostgREST or()/ilike control char from the agent-supplied query
  // so it can only ever be a plain ILIKE substring — no filter breakout.
  const safe = q
    .replace(/[,.()%*:\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  if (safe) {
    builder = builder.or(`title.ilike.%${safe}%,content.ilike.%${safe}%`);
  }
  const { data, error } = await builder;
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToNote);
}

/** Recent note titles, to remind a shift what it already studied. */
export async function recentMemoryTitles(
  client: SupabaseClient,
  personaId: string,
  limit = 8,
): Promise<string[]> {
  const { data, error } = await client
    .from("persona_memory")
    .select("title,created_at")
    .eq("persona_id", personaId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => (typeof r.title === "string" ? r.title : "")).filter(Boolean);
}
