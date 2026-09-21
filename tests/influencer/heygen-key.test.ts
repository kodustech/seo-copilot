/**
 * The HeyGen key a render uses: the persona's own when it has one, else the
 * fleet's shared key from the server, and a clear error when neither exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/influencer/credentials", () => ({ getChannelCredentialCipher: vi.fn() }));
vi.mock("@/lib/crypto/persona-secrets", () => ({ decryptPersonaKey: (c: string) => `decrypted:${c}` }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { getChannelCredentialCipher } from "../../lib/influencer/credentials";
import { resolveHeyGenKey } from "../../lib/influencer/heygen";

const client = {} as SupabaseClient;

describe("resolveHeyGenKey", () => {
  afterEach(() => {
    delete process.env.HEYGEN_API_KEY;
    vi.mocked(getChannelCredentialCipher).mockReset();
  });

  it("prefers the persona's own key", async () => {
    process.env.HEYGEN_API_KEY = "fleet";
    vi.mocked(getChannelCredentialCipher).mockResolvedValue("own");
    expect(await resolveHeyGenKey(client, "p")).toBe("decrypted:own");
  });

  it("falls back to the fleet key", async () => {
    process.env.HEYGEN_API_KEY = "fleet";
    vi.mocked(getChannelCredentialCipher).mockResolvedValue(null);
    expect(await resolveHeyGenKey(client, "p")).toBe("fleet");
  });

  it("says where to put a key when there is none", async () => {
    vi.mocked(getChannelCredentialCipher).mockResolvedValue(null);
    await expect(resolveHeyGenKey(client, "p")).rejects.toThrow(/HEYGEN_API_KEY/);
  });
});
