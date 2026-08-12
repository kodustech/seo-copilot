import { asc, eq } from "drizzle-orm";

import type { Db } from "@/lib/db";
import { personaChannels, personas } from "@/lib/db/schema";

import {
  normalizeAutomationLevel,
  normalizeChannelPlatform,
  normalizeChannelStatus,
  normalizePersonaStatus,
  type AutomationLevel,
  type ChannelPlatform,
  type ChannelStatus,
  type Persona,
  type PersonaChannel,
  type PersonaStatus,
  type PublishVia,
} from "@/lib/influencer/types";

type PersonaRow = typeof personas.$inferSelect;
type ChannelRow = typeof personaChannels.$inferSelect;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBooleanRecord(value: unknown): Record<string, boolean> {
  const record = asRecord(value);
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = Boolean(entry);
  }
  return out;
}

export function rowToPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.displayName,
    bio: row.bio,
    avatar_url: row.avatarUrl,
    backstory: row.backstory,
    disclosure: row.disclosure,
    beat: row.beat,
    tone: row.tone,
    writing_guidelines: row.writingGuidelines,
    preferred_words: row.preferredWords ?? [],
    forbidden_words: row.forbiddenWords ?? [],
    allowed_topics: row.allowedTopics ?? [],
    forbidden_topics: row.forbiddenTopics ?? [],
    content_config: asRecord(row.contentConfig),
    status: normalizePersonaStatus(row.status) ?? "paused",
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function rowToChannel(row: ChannelRow): PersonaChannel {
  return {
    id: row.id,
    persona_id: row.personaId,
    platform: normalizeChannelPlatform(row.platform) ?? "x",
    external_handle: row.externalHandle,
    publish_via: row.publishVia as PublishVia,
    automation_level:
      normalizeAutomationLevel(row.automationLevel) ?? "draft_only",
    max_posts_per_day: row.maxPostsPerDay,
    max_replies_per_day: row.maxRepliesPerDay,
    credentials_ref: row.credentialsRef,
    channel_config: asRecord(row.channelConfig),
    onboarding: asBooleanRecord(row.onboarding),
    status: normalizeChannelStatus(row.status) ?? "pending_setup",
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function listPersonas(db: Db): Promise<Persona[]> {
  const rows = await db.select().from(personas).orderBy(asc(personas.createdAt));
  return rows.map(rowToPersona);
}

export async function listActivePersonas(db: Db): Promise<Persona[]> {
  const rows = await db
    .select()
    .from(personas)
    .where(eq(personas.status, "active"))
    .orderBy(asc(personas.createdAt));
  return rows.map(rowToPersona);
}

export async function getPersona(db: Db, id: string): Promise<Persona | null> {
  const rows = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
  return rows.length ? rowToPersona(rows[0]) : null;
}

export async function listChannels(db: Db): Promise<PersonaChannel[]> {
  const rows = await db
    .select()
    .from(personaChannels)
    .orderBy(asc(personaChannels.createdAt));
  return rows.map(rowToChannel);
}

export async function listChannelsForPersona(
  db: Db,
  personaId: string,
): Promise<PersonaChannel[]> {
  const rows = await db
    .select()
    .from(personaChannels)
    .where(eq(personaChannels.personaId, personaId))
    .orderBy(asc(personaChannels.createdAt));
  return rows.map(rowToChannel);
}

export type CreatePersonaInput = {
  handle: string;
  display_name: string;
  bio: string;
  avatar_url?: string | null;
  backstory: string;
  disclosure: string;
  beat: string;
  tone?: string | null;
  writing_guidelines?: string | null;
  preferred_words?: string[];
  forbidden_words?: string[];
  allowed_topics?: string[];
  forbidden_topics?: string[];
  content_config?: Record<string, unknown>;
  created_by: string;
};

export async function createPersona(
  db: Db,
  input: CreatePersonaInput,
): Promise<Persona> {
  const handle = input.handle.trim().toLowerCase().replace(/^@/, "");
  if (!handle) throw new Error("Persona handle is required.");
  if (!input.disclosure.trim()) {
    throw new Error("Persona disclosure line is required — every persona is openly AI.");
  }

  const rows = await db
    .insert(personas)
    .values({
      handle,
      displayName: input.display_name.trim(),
      bio: input.bio.trim(),
      avatarUrl: input.avatar_url ?? null,
      backstory: input.backstory.trim(),
      disclosure: input.disclosure.trim(),
      beat: input.beat.trim(),
      tone: input.tone ?? null,
      writingGuidelines: input.writing_guidelines ?? null,
      preferredWords: input.preferred_words ?? [],
      forbiddenWords: input.forbidden_words ?? [],
      allowedTopics: input.allowed_topics ?? [],
      forbiddenTopics: input.forbidden_topics ?? [],
      contentConfig: input.content_config ?? {},
      createdBy: input.created_by,
    })
    .returning();

  return rowToPersona(rows[0]);
}

export type PersonaPatch = Partial<{
  display_name: string;
  bio: string;
  avatar_url: string | null;
  backstory: string;
  disclosure: string;
  beat: string;
  tone: string | null;
  writing_guidelines: string | null;
  preferred_words: string[];
  forbidden_words: string[];
  allowed_topics: string[];
  forbidden_topics: string[];
  content_config: Record<string, unknown>;
  status: PersonaStatus;
}>;

export async function updatePersona(
  db: Db,
  id: string,
  patch: PersonaPatch,
): Promise<Persona | null> {
  const set: Partial<typeof personas.$inferInsert> = {};
  if (patch.display_name !== undefined) set.displayName = patch.display_name;
  if (patch.bio !== undefined) set.bio = patch.bio;
  if (patch.avatar_url !== undefined) set.avatarUrl = patch.avatar_url;
  if (patch.backstory !== undefined) set.backstory = patch.backstory;
  if (patch.disclosure !== undefined) {
    if (!patch.disclosure.trim()) {
      throw new Error("Persona disclosure cannot be emptied.");
    }
    set.disclosure = patch.disclosure;
  }
  if (patch.beat !== undefined) set.beat = patch.beat;
  if (patch.tone !== undefined) set.tone = patch.tone;
  if (patch.writing_guidelines !== undefined) {
    set.writingGuidelines = patch.writing_guidelines;
  }
  if (patch.preferred_words !== undefined) set.preferredWords = patch.preferred_words;
  if (patch.forbidden_words !== undefined) set.forbiddenWords = patch.forbidden_words;
  if (patch.allowed_topics !== undefined) set.allowedTopics = patch.allowed_topics;
  if (patch.forbidden_topics !== undefined) set.forbiddenTopics = patch.forbidden_topics;
  if (patch.content_config !== undefined) set.contentConfig = patch.content_config;
  if (patch.status !== undefined) set.status = patch.status;

  if (!Object.keys(set).length) return getPersona(db, id);

  const rows = await db
    .update(personas)
    .set(set)
    .where(eq(personas.id, id))
    .returning();

  return rows.length ? rowToPersona(rows[0]) : null;
}

export type CreateChannelInput = {
  persona_id: string;
  platform: ChannelPlatform;
  external_handle?: string | null;
  publish_via: PublishVia;
  automation_level?: AutomationLevel;
  max_posts_per_day?: number;
  max_replies_per_day?: number;
  credentials_ref?: string | null;
  channel_config?: Record<string, unknown>;
};

export async function createChannel(
  db: Db,
  input: CreateChannelInput,
): Promise<PersonaChannel> {
  const rows = await db
    .insert(personaChannels)
    .values({
      personaId: input.persona_id,
      platform: input.platform,
      externalHandle: input.external_handle ?? null,
      publishVia: input.publish_via,
      automationLevel: input.automation_level ?? "approve_first",
      maxPostsPerDay: input.max_posts_per_day ?? 2,
      maxRepliesPerDay: input.max_replies_per_day ?? 5,
      credentialsRef: input.credentials_ref ?? null,
      channelConfig: input.channel_config ?? {},
    })
    .returning();

  return rowToChannel(rows[0]);
}

export type ChannelPatch = Partial<{
  external_handle: string | null;
  automation_level: AutomationLevel;
  max_posts_per_day: number;
  max_replies_per_day: number;
  credentials_ref: string | null;
  channel_config: Record<string, unknown>;
  onboarding: Record<string, boolean>;
  status: ChannelStatus;
}>;

export async function updateChannel(
  db: Db,
  id: string,
  patch: ChannelPatch,
): Promise<PersonaChannel | null> {
  const set: Partial<typeof personaChannels.$inferInsert> = {};
  if (patch.external_handle !== undefined) set.externalHandle = patch.external_handle;
  if (patch.automation_level !== undefined) set.automationLevel = patch.automation_level;
  if (patch.max_posts_per_day !== undefined) set.maxPostsPerDay = patch.max_posts_per_day;
  if (patch.max_replies_per_day !== undefined) {
    set.maxRepliesPerDay = patch.max_replies_per_day;
  }
  if (patch.credentials_ref !== undefined) set.credentialsRef = patch.credentials_ref;
  if (patch.channel_config !== undefined) set.channelConfig = patch.channel_config;
  if (patch.onboarding !== undefined) set.onboarding = patch.onboarding;
  if (patch.status !== undefined) set.status = patch.status;

  if (!Object.keys(set).length) {
    const rows = await db
      .select()
      .from(personaChannels)
      .where(eq(personaChannels.id, id))
      .limit(1);
    return rows.length ? rowToChannel(rows[0]) : null;
  }

  const rows = await db
    .update(personaChannels)
    .set(set)
    .where(eq(personaChannels.id, id))
    .returning();

  return rows.length ? rowToChannel(rows[0]) : null;
}
