import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeActivityKind,
  normalizeActivityStatus,
  type ActivityKind,
  type ActivityStatus,
  type PersonaActivity,
} from "@/lib/influencer/types";

type Row = Record<string, unknown>;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableText(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function rowToActivity(row: Row): PersonaActivity {
  return {
    id: asText(row.id),
    persona_id: asText(row.persona_id),
    channel_id: asText(row.channel_id),
    kind: normalizeActivityKind(row.kind) ?? "post",
    status: normalizeActivityStatus(row.status) ?? "draft",
    title: asNullableText(row.title),
    content: asText(row.content),
    content_meta: asRecord(row.content_meta),
    source_kind: asNullableText(row.source_kind),
    source_ref: asNullableText(row.source_ref),
    parent_activity_id: asNullableText(row.parent_activity_id),
    scheduled_at: asNullableText(row.scheduled_at),
    published_at: asNullableText(row.published_at),
    external_id: asNullableText(row.external_id),
    external_url: asNullableText(row.external_url),
    error: asNullableText(row.error),
    approved_by: asNullableText(row.approved_by),
    created_at: asText(row.created_at),
    updated_at: asText(row.updated_at),
  };
}

export type NewActivity = {
  persona_id: string;
  channel_id: string;
  kind: ActivityKind;
  status?: ActivityStatus;
  title?: string | null;
  content: string;
  content_meta?: Record<string, unknown>;
  source_kind?: string | null;
  source_ref?: string | null;
  parent_activity_id?: string | null;
  scheduled_at?: string | null;
};

export async function insertActivities(
  client: SupabaseClient,
  items: NewActivity[],
): Promise<PersonaActivity[]> {
  if (!items.length) return [];

  const { data, error } = await client
    .from("persona_activities")
    .insert(
      items.map((item) => ({
        persona_id: item.persona_id,
        channel_id: item.channel_id,
        kind: item.kind,
        status: item.status ?? "draft",
        title: item.title ?? null,
        content: item.content,
        content_meta: item.content_meta ?? {},
        source_kind: item.source_kind ?? null,
        source_ref: item.source_ref ?? null,
        parent_activity_id: item.parent_activity_id ?? null,
        scheduled_at: item.scheduled_at ?? null,
      })),
    )
    .select();

  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToActivity);
}

export async function getActivity(
  client: SupabaseClient,
  id: string,
): Promise<PersonaActivity | null> {
  const { data, error } = await client
    .from("persona_activities")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToActivity(data) : null;
}

export async function listActivities(
  client: SupabaseClient,
  filters: {
    persona_id?: string;
    statuses?: ActivityStatus[];
    limit?: number;
    offset?: number;
  } = {},
): Promise<PersonaActivity[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  let query = client
    .from("persona_activities")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.persona_id) query = query.eq("persona_id", filters.persona_id);
  if (filters.statuses?.length) query = query.in("status", filters.statuses);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToActivity);
}

export type ActivityPatch = Partial<{
  status: ActivityStatus;
  title: string | null;
  content: string;
  content_meta: Record<string, unknown>;
  scheduled_at: string | null;
  published_at: string | null;
  external_id: string | null;
  external_url: string | null;
  error: string | null;
  approved_by: string | null;
}>;

export async function updateActivity(
  client: SupabaseClient,
  id: string,
  patch: ActivityPatch,
): Promise<PersonaActivity | null> {
  if (!Object.keys(patch).length) return getActivity(client, id);

  const { data, error } = await client
    .from("persona_activities")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? rowToActivity(data) : null;
}

/**
 * Review update guarded against races: a single UPDATE whose WHERE also pins
 * the current status, so it only applies while the row is still in one of
 * `allowedFrom`. Returns null when a concurrent reviewer or the publisher
 * moved it first.
 */
export async function updateActivityIfStatus(
  client: SupabaseClient,
  id: string,
  patch: ActivityPatch,
  allowedFrom: ActivityStatus[],
): Promise<PersonaActivity | null> {
  if (!Object.keys(patch).length || !allowedFrom.length) return null;

  const { data, error } = await client
    .from("persona_activities")
    .update(patch)
    .eq("id", id)
    .in("status", allowedFrom)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? rowToActivity(data) : null;
}

/**
 * Atomically claims an activity for publishing: flips it to `publishing` only
 * if it is still in `from`. Returns null when another worker got there first.
 */
export async function claimActivityForPublishing(
  client: SupabaseClient,
  id: string,
  from: ActivityStatus,
): Promise<PersonaActivity | null> {
  const { data, error } = await client
    .from("persona_activities")
    .update({ status: "publishing" })
    .eq("id", id)
    .eq("status", from)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? rowToActivity(data) : null;
}

/**
 * Activities the publisher should look at: approved or scheduled, in both
 * cases only once their scheduled_at (if any) is due — a reviewer can approve
 * with a future date and it must hold.
 */
export async function listDueForPublish(
  client: SupabaseClient,
  nowIso: string,
  limit = 50,
): Promise<PersonaActivity[]> {
  const { data, error } = await client
    .from("persona_activities")
    .select("*")
    .in("status", ["approved", "scheduled"])
    .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToActivity);
}

/**
 * How many activities this channel already put on the wire today (UTC).
 * Counts in-flight `publishing` rows too, so a burst can't slip past the cap.
 */
export async function countPublishedToday(
  client: SupabaseClient,
  channelId: string,
  kinds: ActivityKind[],
  dayStartIso: string,
): Promise<number> {
  const { count, error } = await client
    .from("persona_activities")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channelId)
    .in("kind", kinds)
    .or(
      `status.eq.publishing,and(status.eq.published,published_at.gte.${dayStartIso})`,
    );

  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Whether this persona already got generated drafts since `sinceIso` (UTC day guard). */
export async function hasGeneratedActivitiesSince(
  client: SupabaseClient,
  personaId: string,
  sinceIso: string,
): Promise<boolean> {
  const { count, error } = await client
    .from("persona_activities")
    .select("id", { count: "exact", head: true })
    .eq("persona_id", personaId)
    .eq("source_kind", "feed")
    .gte("created_at", sinceIso);

  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

/**
 * Recent content across the whole fleet, for cross-persona dedup at
 * generation time (two personas must not ship the same take).
 */
export async function listRecentContents(
  client: SupabaseClient,
  sinceIso: string,
): Promise<Array<{ persona_id: string; content: string }>> {
  // Dedup needs recent samples, not the full history — cap the scan so a
  // grown fleet doesn't pull thousands of full content strings into memory.
  const { data, error } = await client
    .from("persona_activities")
    .select("persona_id, content")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    persona_id: String(row.persona_id ?? ""),
    content: String(row.content ?? ""),
  }));
}

/**
 * Recovers claims orphaned by a crash: anything sitting in `publishing` since
 * before `cutoffIso` goes to `failed` (not back to `approved` — the external
 * call may have gone through, and a silent double-post is worse than a human
 * re-approving). Returns how many rows were reset.
 */
export async function resetStalePublishing(
  client: SupabaseClient,
  cutoffIso: string,
): Promise<number> {
  const { data, error } = await client
    .from("persona_activities")
    .update({
      status: "failed",
      error:
        "Publish interrupted (stale claim reset). Check the platform before re-approving — the post may have gone out.",
    })
    .eq("status", "publishing")
    .lte("updated_at", cutoffIso)
    .select("id");

  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
