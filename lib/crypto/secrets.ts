import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Encrypt short secrets (SMTP app passwords) for DB storage.
 * Key is derived from OUTREACH_SECRETS_KEY or SUPABASE_SERVICE_ROLE_KEY —
 * infrastructure only; product config lives in Settings / DB.
 */
function secretsKey(): Buffer {
  const raw =
    process.env.OUTREACH_SECRETS_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!raw) {
    throw new Error(
      "Missing OUTREACH_SECRETS_KEY (or SUPABASE_SERVICE_ROLE_KEY) for secret encryption",
    );
  }
  return createHash("sha256").update(raw).digest();
}

/** Returns base64url payload: v1.<iv>.<tag>.<ciphertext> */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretsKey(), iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted secret format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", secretsKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
