import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Encrypt per-persona provider API keys for DB storage.
 *
 * Uses a DEDICATED master key (INFLUENCER_SECRETS_KEY) so the credential that
 * decrypts a pile of third-party keys lives in as few places as possible and
 * can be rotated on its own — not the broadly-powerful Supabase service role.
 * Falls back to the shared secrets key only so dev works without extra env.
 *
 * The decrypted key is only ever used server-side, in the model-client call.
 * It must NEVER be injected into an agent sandbox or reachable by tool calls.
 */
function personaSecretsKey(): Buffer {
  const raw =
    process.env.INFLUENCER_SECRETS_KEY?.trim() ||
    process.env.OUTREACH_SECRETS_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!raw) {
    throw new Error(
      "Missing INFLUENCER_SECRETS_KEY (or a fallback) for persona key encryption",
    );
  }
  return createHash("sha256").update(raw).digest();
}

/** Returns base64url payload: v1.<iv>.<tag>.<ciphertext> */
export function encryptPersonaKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", personaSecretsKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptPersonaKey(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted persona key format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    personaSecretsKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Last 4 chars for write-only display (never returns the key itself). */
export function keyLast4(plaintext: string): string {
  const trimmed = plaintext.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}
