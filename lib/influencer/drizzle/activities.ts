import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { Db } from "@/lib/db";
import { personaActivities } from "@/lib/db/schema";

import {
  normalizeActivityKind,
  normalizeActivityStatus,
  type ActivityKind,
  type ActivityStatus,
  type PersonaActivity,
} from "@/lib/influencer/types";

type ActivityRow = typeof personaActivities.$inferSelect;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function rowToActivity(row: ActivityRow): PersonaActivity {
  return {
    id: row.id,
    persona_id: row.personaId,
    channel_id: row.channelId,
    kind: normalizeActivityKind(row.kind) ?? "post",
    status: normalizeActivityStatus(row.status) ?? "draft",
    title: row.title,
    content: row.content,
    content_meta: asRecord(row.contentMeta),
    source_kind: row.sourceKind,
    source_ref: row.sourceRef,
    parent_activity_id: row.parentActivityId,
    scheduled_at: row.scheduledAt,
    published_at: row.publishedAt,
    external_id: row.externalId,
    external_url: row.externalUrl,
    error: row.error,
    approved_by: row.approvedBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
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
  db: Db,
  items: NewActivity[],
): Promise<PersonaActivity[]> {
  if (!items.length) return [];

  const rows = await db
    .insert(personaActivities)
    .values(
      items.map((item) => ({
        personaId: item.persona_id,
        channelId: item.channel_id,
        kind: item.kind,
        status: item.status ?? "draft",
        title: item.title ?? null,
        content: item.content,
        contentMeta: item.content_meta ?? {},
        sourceKind: item.source_kind ?? null,
        sourceRef: item.source_ref ?? null,
        parentActivityId: item.parent_activity_id ?? null,
        scheduledAt: item.scheduled_at ?? null,
      })),
    )
    .returning();

  return rows.map(rowToActivity);
}

export async function getActivity(
  db: Db,
  id: string,
): Promise<PersonaActivity | null> {
  const rows = await db
    .select()
    .from(personaActivities)
    .where(eq(personaActivities.id, id))
    .limit(1);
  return rows.length ? rowToActivity(rows[0]) : null;
}

export async function listActivities(
  db: Db,
  filters: {
    persona_id?: string;
    statuses?: ActivityStatus[];
    limit?: number;
    offset?: number;
  } = {},
): Promise<PersonaActivity[]> {
  const conditions = [];
  if (filters.persona_id) {
    conditions.push(eq(personaActivities.personaId, filters.persona_id));
  }
  if (filters.statuses?.length) {
    conditions.push(inArray(personaActivities.status, filters.statuses));
  }

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

  const rows = await db
    .select()
    .from(personaActivities)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(personaActivities.createdAt))
    .limit(limit)
    .offset(Math.max(filters.offset ?? 0, 0));

  return rows.map(rowToActivity);
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
  db: Db,
  id: string,
  patch: ActivityPatch,
): Promise<PersonaActivity | null> {
  const set: Partial<typeof personaActivities.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.content !== undefined) set.content = patch.content;
  if (patch.content_meta !== undefined) set.contentMeta = patch.content_meta;
  if (patch.scheduled_at !== undefined) set.scheduledAt = patch.scheduled_at;
  if (patch.published_at !== undefined) set.publishedAt = patch.published_at;
  if (patch.external_id !== undefined) set.externalId = patch.external_id;
  if (patch.external_url !== undefined) set.externalUrl = patch.external_url;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.approved_by !== undefined) set.approvedBy = patch.approved_by;

  if (!Object.keys(set).length) return getActivity(db, id);

  const rows = await db
    .update(personaActivities)
    .set(set)
    .where(eq(personaActivities.id, id))
    .returning();

  return rows.length ? rowToActivity(rows[0]) : null;
}

/**
 * Atomically claims an activity for publishing: flips it to `publishing` only
 * if it is still in `from`. Returns null when another worker got there first.
 */
export async function claimActivityForPublishing(
  db: Db,
  id: string,
  from: ActivityStatus,
): Promise<PersonaActivity | null> {
  const rows = await db
    .update(personaActivities)
    .set({ status: "publishing" })
    .where(
      and(eq(personaActivities.id, id), eq(personaActivities.status, from)),
    )
    .returning();

  return rows.length ? rowToActivity(rows[0]) : null;
}

/**
 * Activities the publisher should look at: approved, or scheduled with a due
 * scheduled_at (deferred by a daily cap or an explicit schedule).
 */
export async function listDueForPublish(
  db: Db,
  nowIso: string,
  limit = 50,
): Promise<PersonaActivity[]> {
  const rows = await db
    .select()
    .from(personaActivities)
    .where(
      or(
        eq(personaActivities.status, "approved"),
        and(
          eq(personaActivities.status, "scheduled"),
          or(
            isNull(personaActivities.scheduledAt),
            lte(personaActivities.scheduledAt, nowIso),
          ),
        ),
      ),
    )
    .orderBy(personaActivities.createdAt)
    .limit(limit);

  return rows.map(rowToActivity);
}

/**
 * How many activities this channel already put on the wire today (UTC).
 * Counts in-flight `publishing` rows too, so a burst can't slip past the cap.
 */
export async function countPublishedToday(
  db: Db,
  channelId: string,
  kinds: ActivityKind[],
  dayStartIso: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(personaActivities)
    .where(
      and(
        eq(personaActivities.channelId, channelId),
        inArray(personaActivities.kind, kinds),
        or(
          eq(personaActivities.status, "publishing"),
          and(
            eq(personaActivities.status, "published"),
            gte(personaActivities.publishedAt, dayStartIso),
          ),
        ),
      ),
    );

  return rows[0]?.count ?? 0;
}

/** Whether this persona already got generated drafts since `sinceIso` (UTC day guard). */
export async function hasGeneratedActivitiesSince(
  db: Db,
  personaId: string,
  sinceIso: string,
): Promise<boolean> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(personaActivities)
    .where(
      and(
        eq(personaActivities.personaId, personaId),
        eq(personaActivities.sourceKind, "feed"),
        gte(personaActivities.createdAt, sinceIso),
      ),
    );

  return (rows[0]?.count ?? 0) > 0;
}

/**
 * Recent content across the whole fleet, for cross-persona dedup at
 * generation time (two personas must not ship the same take).
 */
export async function listRecentContents(
  db: Db,
  sinceIso: string,
): Promise<Array<{ persona_id: string; content: string }>> {
  const rows = await db
    .select({
      personaId: personaActivities.personaId,
      content: personaActivities.content,
    })
    .from(personaActivities)
    .where(gte(personaActivities.createdAt, sinceIso));

  return rows.map((row) => ({ persona_id: row.personaId, content: row.content }));
}
