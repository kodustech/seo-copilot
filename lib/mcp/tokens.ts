/**
 * Personal MCP access tokens (PATs).
 *
 * - Raw token is shown once at creation; only sha256 is stored.
 * - /api/mcp accepts either a personal token or the legacy shared
 *   MCP_AUTH_TOKEN (when MCP_ALLOW_SHARED_TOKEN is not "false").
 * - Personal tokens fix identity to the token owner (no email spoofing).
 */

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseServiceClient } from "@/lib/supabase-server";

export type McpAuthKind = "personal" | "shared";

export type McpAuthResult = {
  userEmail: string;
  authKind: McpAuthKind;
  tokenId?: string;
};

export type McpTokenListItem = {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type CreateMcpTokenResult = McpTokenListItem & {
  /** Full secret — returned only on create. */
  token: string;
};

const TOKEN_PREFIX_LABEL = "mcp_";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Generate a one-time-show token: mcp_<8hex>_<base64url secret>. */
export function generateToken(): { raw: string; prefix: string; hash: string } {
  const idPart = randomBytes(4).toString("hex"); // 8 hex chars
  const secret = randomBytes(32).toString("base64url");
  const raw = `${TOKEN_PREFIX_LABEL}${idPart}_${secret}`;
  const prefix = `${TOKEN_PREFIX_LABEL}${idPart}`;
  return { raw, prefix, hash: hashToken(raw) };
}

function allowedDomain(): string {
  return (
    process.env.NEXT_PUBLIC_ALLOWED_DOMAIN?.toLowerCase() || "@kodus.io"
  ).toLowerCase();
}

export function isAllowedEmail(email: string): boolean {
  const domain = allowedDomain();
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  // domain may be "@kodus.io" or "kodus.io"
  const suffix = domain.startsWith("@") ? domain : `@${domain}`;
  return normalized.endsWith(suffix);
}

export function sharedTokenAllowed(): boolean {
  const flag = process.env.MCP_ALLOW_SHARED_TOKEN?.trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "no") return false;
  return true;
}

function mapRow(row: Record<string, unknown>): McpTokenListItem {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenPrefix: String(row.token_prefix),
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    expiresAt: (row.expires_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function listPersonalTokens(
  client: SupabaseClient,
  userId: string,
): Promise<McpTokenListItem[]> {
  const { data, error } = await client
    .from("mcp_personal_tokens")
    .select(
      "id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at",
    )
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to list MCP tokens: ${error.message}`);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

export async function createPersonalToken(
  client: SupabaseClient,
  input: {
    userId: string;
    userEmail: string;
    name: string;
    expiresInDays?: number | null;
  },
): Promise<CreateMcpTokenResult> {
  if (!isAllowedEmail(input.userEmail)) {
    throw new Error(
      `Email domain not allowed (need ${allowedDomain()})`,
    );
  }

  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Token name is required");

  const { raw, prefix, hash } = generateToken();

  let expiresAt: string | null = null;
  if (
    typeof input.expiresInDays === "number" &&
    Number.isFinite(input.expiresInDays) &&
    input.expiresInDays > 0
  ) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + Math.min(Math.floor(input.expiresInDays), 3650));
    expiresAt = d.toISOString();
  }

  const { data, error } = await client
    .from("mcp_personal_tokens")
    .insert({
      user_id: input.userId,
      user_email: input.userEmail.toLowerCase(),
      name,
      token_prefix: prefix,
      token_hash: hash,
      expires_at: expiresAt,
    })
    .select(
      "id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at",
    )
    .single();

  if (error || !data) {
    throw new Error(
      `Failed to create MCP token: ${error?.message ?? "unknown"}`,
    );
  }

  return {
    ...mapRow(data as Record<string, unknown>),
    token: raw,
  };
}

export async function revokePersonalToken(
  client: SupabaseClient,
  userId: string,
  tokenId: string,
): Promise<void> {
  const { data, error } = await client
    .from("mcp_personal_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`Failed to revoke MCP token: ${error.message}`);
  if (!data) throw new Error("Token not found or already revoked");
}

async function touchLastUsed(tokenId: string): Promise<void> {
  try {
    const client = getSupabaseServiceClient();
    await client
      .from("mcp_personal_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", tokenId);
  } catch {
    // non-fatal
  }
}

/**
 * Resolve MCP request auth.
 * 1) Shared MCP_AUTH_TOKEN (if allowed)
 * 2) Personal PAT by hash
 */
export async function resolveMcpAuth(
  req: Request,
): Promise<
  | { ok: true; auth: McpAuthResult }
  | { ok: false; status: number; error: string; reason: string }
> {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      reason: "Missing Bearer token",
    };
  }

  const presented = authHeader.slice("Bearer ".length).trim();
  if (!presented) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      reason: "Empty Bearer token",
    };
  }

  // 1) Shared / service token
  const shared = process.env.MCP_AUTH_TOKEN?.trim();
  if (shared && shared.length >= 16 && sharedTokenAllowed()) {
    if (presented === shared) {
      const userEmail =
        req.headers.get("x-mcp-user-email")?.trim() ||
        process.env.MCP_DEFAULT_USER_EMAIL?.trim() ||
        "growth@kodus.io";
      return {
        ok: true,
        auth: { userEmail, authKind: "shared" },
      };
    }
  }

  // 2) Personal PAT
  try {
    const client = getSupabaseServiceClient();
    const hash = hashToken(presented);
    const { data, error } = await client
      .from("mcp_personal_tokens")
      .select("id, user_email, expires_at, revoked_at")
      .eq("token_hash", hash)
      .maybeSingle();

    if (error) {
      console.error("[mcp/auth] lookup failed:", error.message);
      return {
        ok: false,
        status: 500,
        error: "server_error",
        reason: "Token lookup failed",
      };
    }

    if (!data) {
      // Distinguish misconfigured shared-only vs invalid personal
      if (!shared || shared.length < 16) {
        if (!sharedTokenAllowed()) {
          return {
            ok: false,
            status: 401,
            error: "unauthorized",
            reason: "Invalid personal token",
          };
        }
        return {
          ok: false,
          status: 500,
          error: "server_misconfigured",
          reason:
            "MCP_AUTH_TOKEN is not set (or too short) and token is not a valid personal PAT.",
        };
      }
      return {
        ok: false,
        status: 401,
        error: "unauthorized",
        reason: "Invalid token",
      };
    }

    if (data.revoked_at) {
      return {
        ok: false,
        status: 401,
        error: "unauthorized",
        reason: "Token revoked",
      };
    }

    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      return {
        ok: false,
        status: 401,
        error: "unauthorized",
        reason: "Token expired",
      };
    }

    const userEmail = String(data.user_email).toLowerCase();
    // Fire-and-forget last_used
    void touchLastUsed(String(data.id));

    return {
      ok: true,
      auth: {
        userEmail,
        authKind: "personal",
        tokenId: String(data.id),
      },
    };
  } catch (err) {
    console.error("[mcp/auth] resolve error:", err);
    return {
      ok: false,
      status: 500,
      error: "server_error",
      reason: err instanceof Error ? err.message : "Auth failed",
    };
  }
}
