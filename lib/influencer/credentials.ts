import type { SupabaseClient } from "@supabase/supabase-js";

import { encryptPersonaKey, keyLast4 } from "@/lib/crypto/persona-secrets";
import {
  normalizeModelProvider,
  type ModelProvider,
  type PersonaCredentialMeta,
} from "@/lib/influencer/types";

type Row = Record<string, unknown>;

function metaFrom(row: Row): PersonaCredentialMeta {
  return {
    provider: normalizeModelProvider(row.provider) ?? "openai",
    key_last4: typeof row.key_last4 === "string" ? row.key_last4 : "",
    label: typeof row.label === "string" && row.label.length ? row.label : null,
    status: row.status === "revoked" ? "revoked" : "active",
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

const META_COLS = "provider, key_last4, label, status, created_at";

/**
 * Store (or replace) a persona's API key for one provider. Encrypts before
 * write; returns metadata only — the key itself is never echoed back.
 */
export async function setPersonaCredential(
  client: SupabaseClient,
  input: {
    persona_id: string;
    provider: ModelProvider;
    key: string;
    label?: string | null;
    created_by: string;
  },
): Promise<PersonaCredentialMeta> {
  const trimmed = input.key.trim();
  if (!trimmed) throw new Error("API key is required.");

  const { data, error } = await client
    .from("persona_credentials")
    .upsert(
      {
        persona_id: input.persona_id,
        provider: input.provider,
        encrypted_key: encryptPersonaKey(trimmed),
        key_last4: keyLast4(trimmed),
        label: input.label ?? null,
        status: "active",
        created_by: input.created_by,
      },
      { onConflict: "persona_id,provider" },
    )
    .select(META_COLS)
    .single();

  if (error) throw new Error(error.message);
  return metaFrom(data);
}

/** Credential metadata for the UI — never includes the key or its ciphertext. */
export async function listPersonaCredentials(
  client: SupabaseClient,
  personaId: string,
): Promise<PersonaCredentialMeta[]> {
  const { data, error } = await client
    .from("persona_credentials")
    .select(META_COLS)
    .eq("persona_id", personaId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map(metaFrom);
}

export async function deletePersonaCredential(
  client: SupabaseClient,
  personaId: string,
  provider: ModelProvider,
): Promise<void> {
  const { error } = await client
    .from("persona_credentials")
    .delete()
    .eq("persona_id", personaId)
    .eq("provider", provider);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Channel credentials (dev.to api-key, …) — stored in the SAME encrypted vault
// under a platform-named provider, so a channel key never rides in plaintext.
// ---------------------------------------------------------------------------

/** Platforms whose publishing uses an in-app API key (not Post-Bridge). */
export type ChannelCredentialPlatform = "devto";

export async function setChannelCredential(
  client: SupabaseClient,
  input: {
    persona_id: string;
    platform: ChannelCredentialPlatform;
    key: string;
    label?: string | null;
    created_by: string;
  },
): Promise<{ key_last4: string }> {
  const trimmed = input.key.trim();
  if (!trimmed) throw new Error("API key is required.");

  const { data, error } = await client
    .from("persona_credentials")
    .upsert(
      {
        persona_id: input.persona_id,
        provider: input.platform,
        encrypted_key: encryptPersonaKey(trimmed),
        key_last4: keyLast4(trimmed),
        label: input.label ?? null,
        status: "active",
        created_by: input.created_by,
      },
      { onConflict: "persona_id,provider" },
    )
    .select("key_last4")
    .single();

  if (error) throw new Error(error.message);
  return { key_last4: typeof data?.key_last4 === "string" ? data.key_last4 : "" };
}

export async function deleteChannelCredential(
  client: SupabaseClient,
  personaId: string,
  platform: ChannelCredentialPlatform,
): Promise<void> {
  const { error } = await client
    .from("persona_credentials")
    .delete()
    .eq("persona_id", personaId)
    .eq("provider", platform);
  if (error) throw new Error(error.message);
}

/**
 * Server-side ONLY: the encrypted channel key for the publisher to decrypt.
 * Same single-point-of-access discipline as getActiveCredentialCipher.
 */
export async function getChannelCredentialCipher(
  client: SupabaseClient,
  personaId: string,
  platform: ChannelCredentialPlatform,
): Promise<string | null> {
  const { data, error } = await client
    .from("persona_credentials")
    .select("encrypted_key")
    .eq("persona_id", personaId)
    .eq("provider", platform)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return typeof data?.encrypted_key === "string" ? data.encrypted_key : null;
}

/**
 * Server-side ONLY: fetch the encrypted key for the model resolver to decrypt.
 * This is the single place `encrypted_key` is ever selected — keep it out of
 * every other read so the ciphertext never rides along in API responses.
 */
export async function getActiveCredentialCipher(
  client: SupabaseClient,
  personaId: string,
  provider: ModelProvider,
): Promise<string | null> {
  const { data, error } = await client
    .from("persona_credentials")
    .select("encrypted_key")
    .eq("persona_id", personaId)
    .eq("provider", provider)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return typeof data?.encrypted_key === "string" ? data.encrypted_key : null;
}
