import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * What data-access functions accept. Taking the handle as a parameter (rather
 * than importing `db` directly) is what lets a caller run the same function
 * inside a withUser() transaction, against dbAdmin, or standalone.
 */
export type Db = Database | Tx;

/**
 * Two connections, mirroring the split the Supabase clients had:
 *
 *   db      → app_user. Not the table owner, so RLS applies. Reads and writes
 *             on user-scoped tables must go through withUser(), or the policies
 *             match nothing and queries quietly return zero rows.
 *   dbAdmin → postgres (owner). Bypasses RLS. For crons, MCP and jobs that
 *             legitimately work across users — the old service-role client.
 *
 * Pools are stashed on globalThis so Next's HMR doesn't leak one per reload,
 * same as the module-level singletons in lib/supabase-server.ts.
 */
const globalForDb = globalThis as unknown as {
  __pgAppPool?: Pool;
  __pgAdminPool?: Pool;
};

/**
 * Railway's TCP proxy terminates TLS with its own certificate. Match on the
 * actual hostname (not a substring — CodeQL: a URL like rlwy.net.evil.com
 * must not disable verification), falling back to the substring check only
 * when the connection string doesn't parse as a URL.
 */
export function isRailwayProxyUrl(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === "rlwy.net" || host.endsWith(".rlwy.net");
  } catch {
    return connectionString.includes("rlwy.net");
  }
}

function createPool(connectionString: string | undefined, label: string): Pool {
  if (!connectionString) throw new Error(`Missing ${label}`);

  return new Pool({
    connectionString,
    ssl: isRailwayProxyUrl(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

const appPool =
  globalForDb.__pgAppPool ??
  createPool(
    process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL,
    "DATABASE_APP_URL",
  );
const adminPool =
  globalForDb.__pgAdminPool ??
  createPool(
    process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL,
    "DATABASE_ADMIN_URL",
  );

if (process.env.NODE_ENV !== "production") {
  globalForDb.__pgAppPool = appPool;
  globalForDb.__pgAdminPool = adminPool;
}

export const db = drizzle(appPool, { schema });
export const dbAdmin = drizzle(adminPool, { schema });
export { appPool, adminPool, schema };

export type UserClaims = {
  email: string;
  /** auth.uid() — only mcp_personal_tokens scopes by it. */
  sub?: string;
};

/**
 * Runs `fn` with the caller's identity visible to RLS.
 *
 * The claims are set with set_config(..., is_local => true), so they live for
 * exactly this transaction and cannot leak to the next request that borrows the
 * same pooled connection. This is the same shape Supabase gives PostgREST; the
 * auth.jwt()/auth.uid()/auth.role() functions in drizzle/manual/001_auth_compat.sql
 * read from it, which is why the policies restored from the dump work unchanged.
 */
export async function withUser<T>(
  claims: UserClaims,
  fn: (tx: Parameters<Parameters<typeof db.transaction<T>>[0]>[0]) => Promise<T>,
): Promise<T> {
  const payload = JSON.stringify({
    email: claims.email,
    sub: claims.sub,
    role: "authenticated",
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('request.jwt.claims', ${payload}, true)`,
    );
    return fn(tx);
  });
}
