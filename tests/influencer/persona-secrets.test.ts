import { describe, expect, it } from "vitest";

import {
  decryptPersonaKey,
  encryptPersonaKey,
  keyLast4,
} from "@/lib/crypto/persona-secrets";

describe("persona key encryption", () => {
  it("round-trips a key through encrypt/decrypt", () => {
    const key = "sk-proj-abcdef0123456789";
    const payload = encryptPersonaKey(key);
    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload).not.toContain(key); // ciphertext, not plaintext
    expect(decryptPersonaKey(payload)).toBe(key);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const key = "sk-openai-xyz";
    expect(encryptPersonaKey(key)).not.toBe(encryptPersonaKey(key));
  });

  it("rejects tampered payloads (AEAD tag)", () => {
    const payload = encryptPersonaKey("sk-abc");
    const parts = payload.split(".");
    const flipped = Buffer.from(parts[3], "base64url");
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString("base64url");
    expect(() => decryptPersonaKey(parts.join("."))).toThrow();
  });

  it("exposes only the last 4 chars", () => {
    expect(keyLast4("sk-proj-abcdef1234")).toBe("1234");
    expect(keyLast4("ab")).toBe("ab");
  });
});
