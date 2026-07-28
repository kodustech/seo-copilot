/**
 * Read-only access to Kodus self-hosted product telemetry (Neon Postgres).
 *
 * Env: TELEMETRY_DATABASE_URL — postgres connection string (prefer a RO user).
 * Never write credentials into the repo; configure Railway/local .env only.
 */

import { Pool, type QueryResultRow } from "pg";

const MAX_ROWS = 500;
const DEFAULT_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 15_000;

let pool: Pool | null = null;

export function isTelemetryConfigured(): boolean {
  return Boolean(process.env.TELEMETRY_DATABASE_URL?.trim());
}

function getPool(): Pool {
  const connectionString = process.env.TELEMETRY_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "TELEMETRY_DATABASE_URL is not set. Add the read-only Neon connection string for kodus_telemetry.",
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      // Neon pooler + sslmode=require
      ssl: { rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

/** Strip /* ... */ and -- comments so guards cannot be bypassed with comment gaps. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

/** Quote a SQL identifier; only allow simple names (no dots/spaces). */
function quoteIdent(ident: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQL identifier: ${ident}`);
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

/** Only allow read-only SQL. */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new Error("Empty SQL");
  if (trimmed.includes(";")) {
    throw new Error("Multiple statements are not allowed");
  }

  // Validate on comment-stripped text so `DELETE/*x*/FROM` cannot sneak past.
  const bare = stripSqlComments(trimmed).replace(/\s+/g, " ").trim();
  const head = bare.replace(/^\(/, "").trimStart();
  if (!/^(select|with|show|explain)\b/i.test(head)) {
    throw new Error("Only SELECT / WITH / SHOW / EXPLAIN queries are allowed");
  }

  // Block write/DDL even inside CTEs (e.g. WITH x AS (DELETE FROM ...)).
  const dangerous =
    /\b(insert\s+into|update\s+\w|delete\s+from|drop\s+|alter\s+|create\s+|truncate\s+|grant\s+|revoke\s+|copy\s+|call\s+|do\s+\$\$|refresh\s+materialized|vacuum\s+|reindex\s+)/i;
  if (dangerous.test(bare)) {
    throw new Error("Write/DDL statements are not allowed on telemetry DB");
  }

  return trimmed;
}

function ensureLimit(sql: string, maxRows: number): string {
  if (/\blimit\s+\d+/i.test(sql)) return sql;
  return `${sql}\nLIMIT ${maxRows}`;
}

async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number; fields: string[] }> {
  const client = await getPool().connect();
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await client.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map((f) => f.name),
    };
  } finally {
    client.release();
  }
}

export type TelemetryTableSummary = {
  schema: string;
  name: string;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  approxRows: number | null;
};

export async function describeTelemetrySchema(opts?: {
  table?: string | null;
}): Promise<{
  configured: true;
  tables: TelemetryTableSummary[];
  notes: string[];
}> {
  const tableFilter = opts?.table?.trim() || null;

  const tablesRes = await query<{
    table_schema: string;
    table_name: string;
  }>(
    `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND ($1::text IS NULL OR table_name = $1)
    ORDER BY table_name
    `,
    [tableFilter],
  );

  const tables: TelemetryTableSummary[] = [];
  for (const t of tablesRes.rows) {
    const cols = await query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      `,
      [t.table_schema, t.table_name],
    );

    let approxRows: number | null = null;
    try {
      // Identifiers come from information_schema; still quote-escape safely.
      const from = `${quoteIdent(t.table_schema)}.${quoteIdent(t.table_name)}`;
      const cnt = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ${from}`,
      );
      approxRows = Number(cnt.rows[0]?.n ?? 0);
    } catch {
      approxRows = null;
    }

    tables.push({
      schema: t.table_schema,
      name: t.table_name,
      columns: cols.rows.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
      })),
      approxRows,
    });
  }

  return {
    configured: true,
    tables,
    notes: [
      "Self-hosted Kodus product telemetry (heartbeats from customer instances).",
      "Main tables: telemetry_instances (one row per instance), telemetry_heartbeats (daily payload jsonb).",
      "Heartbeat payload keys typically: kodus, config, runtime, usage_7d, instance_id, schema_version, sent_at.",
      "usage_7d often has: teams, active_users, prs_reviewed, organizations, repos_connected, suggestions_*.",
      "Read-only user — only SELECT/WITH allowed via runTelemetryQuery.",
    ],
  };
}

export async function runTelemetryQuery(opts: {
  sql: string;
  maxRows?: number;
}): Promise<{
  rows: QueryResultRow[];
  rowCount: number;
  fields: string[];
  truncated: boolean;
}> {
  const maxRows = Math.min(
    Math.max(1, opts.maxRows ?? DEFAULT_ROWS),
    MAX_ROWS,
  );
  const safe = assertReadOnlySql(opts.sql);
  const limited = ensureLimit(safe, maxRows);
  const result = await query(limited);
  return {
    rows: result.rows,
    rowCount: result.rowCount,
    fields: result.fields,
    truncated: result.rowCount >= maxRows,
  };
}

export async function listTelemetryInstances(opts?: {
  limit?: number;
  activeDays?: number;
}): Promise<{
  instances: Array<{
    instanceId: string;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    lastVersion: string | null;
    lastDeployment: string | null;
    totalHeartbeats: number;
  }>;
}> {
  const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
  const activeDays = opts?.activeDays;
  const params: unknown[] = [limit];
  let where = "";
  if (activeDays != null && activeDays > 0) {
    params.unshift(activeDays);
    where = `WHERE last_seen_at >= now() - ($1::int * interval '1 day')`;
  }
  const limitParam = activeDays != null && activeDays > 0 ? "$2" : "$1";
  const result = await query<{
    instance_id: string;
    first_seen_at: Date | string | null;
    last_seen_at: Date | string | null;
    last_version: string | null;
    last_deployment: string | null;
    total_heartbeats: number;
  }>(
    `
    SELECT instance_id, first_seen_at, last_seen_at, last_version,
           last_deployment, total_heartbeats
    FROM telemetry_instances
    ${where}
    ORDER BY last_seen_at DESC NULLS LAST
    LIMIT ${limitParam}
    `,
    params,
  );

  return {
    instances: result.rows.map((r) => ({
      instanceId: r.instance_id,
      firstSeenAt: r.first_seen_at ? String(r.first_seen_at) : null,
      lastSeenAt: r.last_seen_at ? String(r.last_seen_at) : null,
      lastVersion: r.last_version,
      lastDeployment: r.last_deployment,
      totalHeartbeats: Number(r.total_heartbeats ?? 0),
    })),
  };
}

export async function getTelemetryInstance(opts: {
  instanceId: string;
  heartbeats?: number;
}): Promise<{
  instance: Record<string, unknown> | null;
  recentHeartbeats: Array<{
    id: string;
    day: string | null;
    schemaVersion: number | null;
    receivedAt: string | null;
    payload: unknown;
  }>;
}> {
  const instanceId = opts.instanceId.trim();
  if (!instanceId) throw new Error("instanceId is required");
  const hbLimit = Math.min(Math.max(1, opts.heartbeats ?? 7), 30);

  const inst = await query(
    `
    SELECT instance_id, first_seen_at, last_seen_at, last_version,
           last_deployment, total_heartbeats
    FROM telemetry_instances
    WHERE instance_id = $1::uuid
    `,
    [instanceId],
  );

  const hbs = await query<{
    id: string | number;
    day: string | Date | null;
    schema_version: number | null;
    received_at: string | Date | null;
    payload: unknown;
  }>(
    `
    SELECT id, day, schema_version, received_at, payload
    FROM telemetry_heartbeats
    WHERE instance_id = $1::uuid
    ORDER BY received_at DESC NULLS LAST
    LIMIT $2
    `,
    [instanceId, hbLimit],
  );

  const row = inst.rows[0] as
    | {
        instance_id: string;
        first_seen_at: unknown;
        last_seen_at: unknown;
        last_version: string | null;
        last_deployment: string | null;
        total_heartbeats: number;
      }
    | undefined;
  return {
    instance: row
      ? {
          instanceId: row.instance_id,
          firstSeenAt: row.first_seen_at
            ? String(row.first_seen_at)
            : null,
          lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
          lastVersion: row.last_version,
          lastDeployment: row.last_deployment,
          totalHeartbeats: Number(row.total_heartbeats ?? 0),
        }
      : null,
    recentHeartbeats: hbs.rows.map((h) => ({
      id: String(h.id),
      day: h.day ? String(h.day).slice(0, 10) : null,
      schemaVersion: h.schema_version,
      receivedAt: h.received_at ? String(h.received_at) : null,
      payload: h.payload,
    })),
  };
}
