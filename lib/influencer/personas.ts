import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeAutomationLevel,
  normalizeChannelPlatform,
  normalizeChannelStatus,
  normalizeModelProvider,
  normalizePersonaStatus,
  type AutomationLevel,
  type ChannelPlatform,
  type ChannelStatus,
  type ModelProvider,
  type Persona,
  type PersonaChannel,
  type PersonaStatus,
  type PublishVia,
} from "@/lib/influencer/types";

type Row = Record<string, unknown>;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableText(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

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

export function rowToPersona(row: Row): Persona {
  return {
    id: asText(row.id),
    handle: asText(row.handle),
    display_name: asText(row.display_name),
    bio: asText(row.bio),
    avatar_url: asNullableText(row.avatar_url),
    backstory: asText(row.backstory),
    disclosure: asText(row.disclosure),
    beat: asText(row.beat),
    tone: asNullableText(row.tone),
    writing_guidelines: asNullableText(row.writing_guidelines),
    preferred_words: asStringArray(row.preferred_words),
    forbidden_words: asStringArray(row.forbidden_words),
    allowed_topics: asStringArray(row.allowed_topics),
    forbidden_topics: asStringArray(row.forbidden_topics),
    content_config: asRecord(row.content_config),
    model_provider: normalizeModelProvider(row.model_provider),
    model_name: asNullableText(row.model_name),
    model_base_url: asNullableText(row.model_base_url),
    status: normalizePersonaStatus(row.status) ?? "paused",
    created_by: asText(row.created_by),
    created_at: asText(row.created_at),
    updated_at: asText(row.updated_at),
  };
}

export function rowToChannel(row: Row): PersonaChannel {
  return {
    id: asText(row.id),
    persona_id: asText(row.persona_id),
    platform: normalizeChannelPlatform(row.platform) ?? "x",
    external_handle: asNullableText(row.external_handle),
    publish_via: asText(row.publish_via) as PublishVia,
    automation_level:
      normalizeAutomationLevel(row.automation_level) ?? "draft_only",
    max_posts_per_day: Number(row.max_posts_per_day ?? 0),
    max_replies_per_day: Number(row.max_replies_per_day ?? 0),
    credentials_ref: asNullableText(row.credentials_ref),
    channel_config: asRecord(row.channel_config),
    onboarding: asBooleanRecord(row.onboarding),
    status: normalizeChannelStatus(row.status) ?? "pending_setup",
    created_at: asText(row.created_at),
    updated_at: asText(row.updated_at),
  };
}

export async function listPersonas(client: SupabaseClient): Promise<Persona[]> {
  const { data, error } = await client
    .from("personas")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToPersona);
}

export async function listActivePersonas(
  client: SupabaseClient,
): Promise<Persona[]> {
  const { data, error } = await client
    .from("personas")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToPersona);
}

export async function getPersona(
  client: SupabaseClient,
  id: string,
): Promise<Persona | null> {
  const { data, error } = await client
    .from("personas")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToPersona(data) : null;
}

export async function getChannel(
  client: SupabaseClient,
  id: string,
): Promise<PersonaChannel | null> {
  const { data, error } = await client
    .from("persona_channels")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToChannel(data) : null;
}

export async function listChannels(
  client: SupabaseClient,
): Promise<PersonaChannel[]> {
  const { data, error } = await client
    .from("persona_channels")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToChannel);
}

export async function listChannelsForPersona(
  client: SupabaseClient,
  personaId: string,
): Promise<PersonaChannel[]> {
  const { data, error } = await client
    .from("persona_channels")
    .select("*")
    .eq("persona_id", personaId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToChannel);
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
  client: SupabaseClient,
  input: CreatePersonaInput,
): Promise<Persona> {
  const handle = input.handle.trim().toLowerCase().replace(/^@/, "");
  if (!handle) throw new Error("Persona handle is required.");
  if (!input.disclosure.trim()) {
    throw new Error(
      "Persona disclosure line is required — every persona is openly AI.",
    );
  }

  const { data, error } = await client
    .from("personas")
    .insert({
      handle,
      display_name: input.display_name.trim(),
      bio: input.bio.trim(),
      avatar_url: input.avatar_url ?? null,
      backstory: input.backstory.trim(),
      disclosure: input.disclosure.trim(),
      beat: input.beat.trim(),
      tone: input.tone ?? null,
      writing_guidelines: input.writing_guidelines ?? null,
      preferred_words: input.preferred_words ?? [],
      forbidden_words: input.forbidden_words ?? [],
      allowed_topics: input.allowed_topics ?? [],
      forbidden_topics: input.forbidden_topics ?? [],
      content_config: input.content_config ?? {},
      created_by: input.created_by,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToPersona(data);
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
  model_provider: ModelProvider | null;
  model_name: string | null;
  model_base_url: string | null;
  status: PersonaStatus;
}>;

export async function updatePersona(
  client: SupabaseClient,
  id: string,
  patch: PersonaPatch,
): Promise<Persona | null> {
  if (patch.disclosure !== undefined && !patch.disclosure.trim()) {
    throw new Error("Persona disclosure cannot be emptied.");
  }
  if (!Object.keys(patch).length) return getPersona(client, id);

  const { data, error } = await client
    .from("personas")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? rowToPersona(data) : null;
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
  client: SupabaseClient,
  input: CreateChannelInput,
): Promise<PersonaChannel> {
  const { data, error } = await client
    .from("persona_channels")
    .insert({
      persona_id: input.persona_id,
      platform: input.platform,
      external_handle: input.external_handle ?? null,
      publish_via: input.publish_via,
      automation_level: input.automation_level ?? "approve_first",
      max_posts_per_day: input.max_posts_per_day ?? 2,
      max_replies_per_day: input.max_replies_per_day ?? 5,
      credentials_ref: input.credentials_ref ?? null,
      channel_config: input.channel_config ?? {},
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToChannel(data);
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
  client: SupabaseClient,
  id: string,
  patch: ChannelPatch,
): Promise<PersonaChannel | null> {
  if (!Object.keys(patch).length) {
    const { data, error } = await client
      .from("persona_channels")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? rowToChannel(data) : null;
  }

  const { data, error } = await client
    .from("persona_channels")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? rowToChannel(data) : null;
}
