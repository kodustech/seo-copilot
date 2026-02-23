import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

const DEFAULT_GLOBAL_SCOPE = "kodus";
const DEFAULT_VOICE_ADMIN_EMAILS = [
  "gabriel@kodus.io",
  "edvaldo.freitas@kodus.io",
];

type VoiceProfileRow = {
  tone: string | null;
  persona: string | null;
  writing_guidelines: string | null;
  preferred_words: string[] | null;
  forbidden_words: string[] | null;
  additional_instructions: string | null;
};

export type VoiceProfile = {
  tone: string | null;
  persona: string | null;
  writingGuidelines: string | null;
  preferredWords: string[];
  forbiddenWords: string[];
  additionalInstructions: string | null;
};

export type VoiceProfilePatch = Partial<{
  tone: string | null;
  persona: string | null;
  writingGuidelines: string | null;
  preferredWords: string[];
  forbiddenWords: string[];
  additionalInstructions: string | null;
}>;

export type VoicePolicyMode = "auto" | "global" | "user" | "custom";

export type VoicePolicyPayload = {
  userEmail: string | null;
  globalProfile: VoiceProfile | null;
  userProfile: VoiceProfile | null;
  mergedProfile: VoiceProfile;
  prompt: string;
  mode?: VoicePolicyMode;
};

function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWordList(value: unknown): string[] {
  const rawItems: string[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        rawItems.push(item);
      }
    }
  } else if (typeof value === "string") {
    rawItems.push(...value.split(/[\n,;]/g));
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of rawItems) {
    const clean = item.trim();
    if (!clean) continue;

    const lookup = clean.toLowerCase();
    if (seen.has(lookup)) continue;

    seen.add(lookup);
    normalized.push(clean);
  }

  return normalized;
}

export function emptyVoiceProfile(): VoiceProfile {
  return {
    tone: null,
    persona: null,
    writingGuidelines: null,
    preferredWords: [],
    forbiddenWords: [],
    additionalInstructions: null,
  };
}

function normalizeVoiceProfileRow(row: VoiceProfileRow | null): VoiceProfile | null {
  if (!row) return null;

  return {
    tone: normalizeNullableText(row.tone),
    persona: normalizeNullableText(row.persona),
    writingGuidelines: normalizeNullableText(row.writing_guidelines),
    preferredWords: normalizeWordList(row.preferred_words),
    forbiddenWords: normalizeWordList(row.forbidden_words),
    additionalInstructions: normalizeNullableText(row.additional_instructions),
  };
}

function joinInstructions(...parts: Array<string | null | undefined>): string | null {
  const lines = parts
    .map((part) => normalizeNullableText(part))
    .filter((part): part is string => Boolean(part));

  if (!lines.length) return null;

  const unique = Array.from(new Set(lines));
  return unique.join("\n\n");
}

function mergeWordLists(
  first?: string[] | null,
  second?: string[] | null,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const word of [...(first ?? []), ...(second ?? [])]) {
    const clean = word.trim();
    if (!clean) continue;

    const lookup = clean.toLowerCase();
    if (seen.has(lookup)) continue;

    seen.add(lookup);
    merged.push(clean);
  }

  return merged;
}

export function mergeVoiceProfiles(
  globalProfile: VoiceProfile | null,
  userProfile: VoiceProfile | null,
): VoiceProfile {
  const fallback = emptyVoiceProfile();

  return {
    tone: userProfile?.tone ?? globalProfile?.tone ?? fallback.tone,
    persona: userProfile?.persona ?? globalProfile?.persona ?? fallback.persona,
    writingGuidelines: joinInstructions(
      globalProfile?.writingGuidelines,
      userProfile?.writingGuidelines,
    ),
    preferredWords: mergeWordLists(
      globalProfile?.preferredWords,
      userProfile?.preferredWords,
    ),
    forbiddenWords: mergeWordLists(
      globalProfile?.forbiddenWords,
      userProfile?.forbiddenWords,
    ),
    additionalInstructions: joinInstructions(
      globalProfile?.additionalInstructions,
      userProfile?.additionalInstructions,
    ),
  };
}

function buildVoicePrompt(payload: {
  mergedProfile: VoiceProfile;
  globalProfile: VoiceProfile | null;
  userProfile: VoiceProfile | null;
}): string {
  const { mergedProfile, globalProfile, userProfile } = payload;

  const hasRules = Boolean(
    mergedProfile.tone ||
      mergedProfile.persona ||
      mergedProfile.writingGuidelines ||
      mergedProfile.additionalInstructions ||
      mergedProfile.preferredWords.length ||
      mergedProfile.forbiddenWords.length,
  );

  if (!hasRules) {
    return "No explicit voice policy configured. Use clear, concise professional language.";
  }

  const lines: string[] = [
    "Follow this writing policy for all generated outputs.",
  ];

  if (globalProfile) {
    lines.push("Scope: Kodus global policy is active.");
  }

  if (userProfile) {
    lines.push("Scope: user-specific policy is active and overrides global tone/persona when present.");
  }

  if (mergedProfile.tone) {
    lines.push(`Tone: ${mergedProfile.tone}`);
  }

  if (mergedProfile.persona) {
    lines.push(`Persona: ${mergedProfile.persona}`);
  }

  if (mergedProfile.writingGuidelines) {
    lines.push(`Writing guidelines: ${mergedProfile.writingGuidelines}`);
  }

  if (mergedProfile.preferredWords.length) {
    lines.push(
      `Preferred words/phrases: ${mergedProfile.preferredWords.join(", ")}`,
    );
  }

  if (mergedProfile.forbiddenWords.length) {
    lines.push(
      `Forbidden words/phrases: ${mergedProfile.forbiddenWords.join(", ")}`,
    );
  }

  if (mergedProfile.additionalInstructions) {
    lines.push(`Additional instructions: ${mergedProfile.additionalInstructions}`);
  }

  return lines.join("\n");
}

export function toVoicePolicyPayload({
  userEmail,
  globalProfile,
  userProfile,
}: {
  userEmail?: string | null;
  globalProfile: VoiceProfile | null;
  userProfile: VoiceProfile | null;
}): VoicePolicyPayload {
  const mergedProfile = mergeVoiceProfiles(globalProfile, userProfile);

  return {
    userEmail: userEmail ?? null,
    globalProfile,
    userProfile,
    mergedProfile,
    prompt: buildVoicePrompt({
      mergedProfile,
      globalProfile,
      userProfile,
    }),
  };
}

export function applyVoicePolicyMode(
  basePolicy: VoicePolicyPayload,
  mode: VoicePolicyMode,
  customTone?: string | null,
): VoicePolicyPayload {
  if (mode === "global") {
    return {
      ...toVoicePolicyPayload({
        userEmail: basePolicy.userEmail,
        globalProfile: basePolicy.globalProfile,
        userProfile: null,
      }),
      mode,
    };
  }

  if (mode === "user") {
    return {
      ...toVoicePolicyPayload({
        userEmail: basePolicy.userEmail,
        globalProfile: null,
        userProfile: basePolicy.userProfile,
      }),
      mode,
    };
  }

  if (mode === "custom") {
    const normalizedCustomTone = normalizeNullableText(customTone ?? null);
    const customUserProfile: VoiceProfile = {
      ...(basePolicy.userProfile ?? emptyVoiceProfile()),
      tone: normalizedCustomTone,
    };

    return {
      ...toVoicePolicyPayload({
        userEmail: basePolicy.userEmail,
        globalProfile: basePolicy.globalProfile,
        userProfile: customUserProfile,
      }),
      mode,
    };
  }

  return { ...basePolicy, mode: "auto" };
}

export function parseVoiceProfilePatch(body: unknown): VoiceProfilePatch {
  if (!body || typeof body !== "object") {
    return {};
  }

  const record = body as Record<string, unknown>;
  const patch: VoiceProfilePatch = {};

  if ("tone" in record) {
    patch.tone = normalizeNullableText(record.tone);
  }

  if ("persona" in record) {
    patch.persona = normalizeNullableText(record.persona);
  }

  if ("writingGuidelines" in record || "writing_guidelines" in record) {
    patch.writingGuidelines = normalizeNullableText(
      record.writingGuidelines ?? record.writing_guidelines,
    );
  }

  if ("preferredWords" in record || "preferred_words" in record) {
    patch.preferredWords = normalizeWordList(
      record.preferredWords ?? record.preferred_words,
    );
  }

  if ("forbiddenWords" in record || "forbidden_words" in record) {
    patch.forbiddenWords = normalizeWordList(
      record.forbiddenWords ?? record.forbidden_words,
    );
  }

  if (
    "additionalInstructions" in record ||
    "additional_instructions" in record
  ) {
    patch.additionalInstructions = normalizeNullableText(
      record.additionalInstructions ?? record.additional_instructions,
    );
  }

  return patch;
}

export function isVoiceProfilePatchEmpty(patch: VoiceProfilePatch): boolean {
  return Object.keys(patch).length === 0;
}

function patchToDatabasePayload(
  patch: VoiceProfilePatch,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if ("tone" in patch) {
    payload.tone = patch.tone;
  }

  if ("persona" in patch) {
    payload.persona = patch.persona;
  }

  if ("writingGuidelines" in patch) {
    payload.writing_guidelines = patch.writingGuidelines;
  }

  if ("preferredWords" in patch) {
    payload.preferred_words = patch.preferredWords;
  }

  if ("forbiddenWords" in patch) {
    payload.forbidden_words = patch.forbiddenWords;
  }

  if ("additionalInstructions" in patch) {
    payload.additional_instructions = patch.additionalInstructions;
  }

  return payload;
}

export async function getGlobalVoiceProfile(
  client: SupabaseClient,
  scope = DEFAULT_GLOBAL_SCOPE,
): Promise<VoiceProfile | null> {
  const { data, error } = await client
    .from("brand_voice_profiles")
    .select(
      "tone, persona, writing_guidelines, preferred_words, forbidden_words, additional_instructions",
    )
    .eq("scope", scope)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return normalizeVoiceProfileRow((data as VoiceProfileRow | null) ?? null);
}

export async function getUserVoiceProfile(
  client: SupabaseClient,
  userEmail: string,
): Promise<VoiceProfile | null> {
  const { data, error } = await client
    .from("user_voice_profiles")
    .select(
      "tone, persona, writing_guidelines, preferred_words, forbidden_words, additional_instructions",
    )
    .eq("user_email", userEmail)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return normalizeVoiceProfileRow((data as VoiceProfileRow | null) ?? null);
}

export async function upsertGlobalVoiceProfile(
  client: SupabaseClient,
  patch: VoiceProfilePatch,
  options?: {
    scope?: string;
    updatedBy?: string | null;
  },
): Promise<VoiceProfile> {
  const scope = options?.scope ?? DEFAULT_GLOBAL_SCOPE;
  const payload = {
    scope,
    ...patchToDatabasePayload(patch),
    updated_at: new Date().toISOString(),
    updated_by: normalizeNullableText(options?.updatedBy ?? null),
  };

  const { data, error } = await client
    .from("brand_voice_profiles")
    .upsert(payload, { onConflict: "scope" })
    .select(
      "tone, persona, writing_guidelines, preferred_words, forbidden_words, additional_instructions",
    )
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const normalized = normalizeVoiceProfileRow((data as VoiceProfileRow | null) ?? null);
  return normalized ?? emptyVoiceProfile();
}

export async function upsertUserVoiceProfile(
  client: SupabaseClient,
  userEmail: string,
  patch: VoiceProfilePatch,
): Promise<VoiceProfile> {
  const payload = {
    user_email: userEmail,
    ...patchToDatabasePayload(patch),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await client
    .from("user_voice_profiles")
    .upsert(payload, { onConflict: "user_email" })
    .select(
      "tone, persona, writing_guidelines, preferred_words, forbidden_words, additional_instructions",
    )
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const normalized = normalizeVoiceProfileRow((data as VoiceProfileRow | null) ?? null);
  return normalized ?? emptyVoiceProfile();
}

export async function resolveVoicePolicyForUser(
  userEmail?: string | null,
): Promise<VoicePolicyPayload> {
  const normalizedEmail =
    typeof userEmail === "string" && userEmail.trim().length > 0
      ? userEmail.trim().toLowerCase()
      : null;

  let globalProfile: VoiceProfile | null = null;
  let userProfile: VoiceProfile | null = null;

  try {
    const client = getSupabaseServiceClient();
    globalProfile = await getGlobalVoiceProfile(client);

    if (normalizedEmail) {
      userProfile = await getUserVoiceProfile(client, normalizedEmail);
    }
  } catch (error) {
    console.warn("[voice-policy] Failed to resolve policy, using fallback.", error);
  }

  return toVoicePolicyPayload({
    userEmail: normalizedEmail,
    globalProfile,
    userProfile,
  });
}

export async function resolveVoicePolicyForRequest(
  authHeader: string | null,
): Promise<VoicePolicyPayload> {
  let userEmail: string | null = null;

  if (authHeader) {
    try {
      const { userEmail: resolvedEmail } = await getSupabaseUserClient(authHeader);
      userEmail = resolvedEmail;
    } catch {
      userEmail = null;
    }
  }

  return resolveVoicePolicyForUser(userEmail);
}

export function canEditGlobalVoice(userEmail: string): boolean {
  const normalized = userEmail.trim().toLowerCase();
  const configured = (process.env.VOICE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const allowed = new Set<string>([
    ...DEFAULT_VOICE_ADMIN_EMAILS,
    ...configured,
  ]);

  return allowed.has(normalized);
}

export function voiceProfilesTableMissingMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (!/brand_voice_profiles|user_voice_profiles/i.test(message)) {
    return null;
  }

  return [
    "The voice profile tables are missing or outdated in Supabase.",
    "Run docs/voice_profiles.sql and try again.",
  ].join(" ");
}
