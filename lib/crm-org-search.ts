/**
 * Product-org autocomplete for CRM account linking.
 *
 * Prefer product_signals_latest (fast, denormalized by the sweep).
 * Fall back to live BigQuery organizations when the table is empty or missing
 * (migration not applied / sweep never ran).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { queryBigQuery } from "@/lib/bigquery";

export type OrgSearchHit = {
  orgId: string;
  name: string | null;
  orgType: string | null;
  userCount: number | null;
  planType: string | null;
  tier: string | null;
  connectedGit: boolean | null;
  source: "signals" | "bigquery";
};

function sanitizeSearch(q: string): string {
  // Alphanumeric + common name punctuation only — strips anything that
  // could break PostgREST `.or()` or a BQ LIKE string.
  return q
    .replace(/[^a-zA-Z0-9 ._@\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeBqLiteral(q: string): string {
  return q.replace(/'/g, "''");
}

async function searchSignalsTable(
  client: SupabaseClient,
  q: string,
): Promise<OrgSearchHit[]> {
  const { data, error } = await client
    .from("product_signals_latest")
    .select("org_id,org_name,org_type,user_count,plan_type,tier,connected_git")
    .or(`org_name.ilike.%${q}%,org_id.ilike.${q}%`)
    .order("user_count", { ascending: false, nullsFirst: false })
    .limit(10);
  if (error) {
    // Table missing or not in schema cache — treat as empty, fall through.
    if (
      /Could not find the table|does not exist|schema cache/i.test(error.message)
    ) {
      return [];
    }
    throw new Error(error.message);
  }
  return (data ?? []).map((r) => ({
    orgId: String(r.org_id),
    name: (r.org_name as string | null) ?? null,
    orgType: (r.org_type as string | null) ?? null,
    userCount:
      r.user_count == null || !Number.isFinite(Number(r.user_count))
        ? null
        : Number(r.user_count),
    planType: (r.plan_type as string | null) ?? null,
    tier: (r.tier as string | null) ?? null,
    connectedGit:
      typeof r.connected_git === "boolean" ? r.connected_git : null,
    source: "signals" as const,
  }));
}

async function searchBigQueryOrgs(q: string): Promise<OrgSearchHit[]> {
  // uuid paste: exact match
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      q,
    ) || /^[a-zA-Z0-9_-]{16,64}$/.test(q);

  const safe = escapeBqLiteral(q);
  if (!safe) return [];

  const where = isUuid
    ? `o.uuid = '${safe}'`
    : `(LOWER(o.name) LIKE LOWER('%${safe}%') OR LOWER(IFNULL(o.tenantName, '')) LIKE LOWER('%${safe}%'))`;

  const sql = `
    SELECT
      o.uuid AS org_id,
      o.name AS org_name,
      o.tenantName AS tenant_name,
      o.status AS active,
      (SELECT COUNT(*) FROM \`kody-408918.kodus_postgres.users\` u
        WHERE u.organization_id = o.uuid) AS user_count
    FROM \`kody-408918.kodus_postgres.organizations\` o
    WHERE ${where}
    ORDER BY user_count DESC
    LIMIT 10
  `;

  const { rows } = await queryBigQuery(sql, 10);
  return rows.map((r) => {
    const name =
      (typeof r.org_name === "string" && r.org_name) ||
      (typeof r.tenant_name === "string" && r.tenant_name) ||
      null;
    const userCount =
      r.user_count == null || !Number.isFinite(Number(r.user_count))
        ? null
        : Number(r.user_count);
    return {
      orgId: String(r.org_id ?? ""),
      name,
      orgType: null,
      userCount,
      planType: null,
      tier: null,
      connectedGit: null,
      source: "bigquery" as const,
    };
  }).filter((h) => h.orgId);
}

/**
 * Search product orgs by name (or id).
 * Returns hits + a soft reason when empty so the UI can explain itself.
 */
export async function searchProductOrgs(
  client: SupabaseClient,
  rawQuery: string,
): Promise<{ orgs: OrgSearchHit[]; source: "signals" | "bigquery" | "none"; note?: string }> {
  const q = sanitizeSearch(rawQuery);
  if (q.length < 2) return { orgs: [], source: "none" };

  try {
    const fromSignals = await searchSignalsTable(client, q);
    if (fromSignals.length > 0) {
      return { orgs: fromSignals, source: "signals" };
    }
  } catch (err) {
    // Continue to BQ; surface only if BQ also fails
    console.warn("[org-search] signals lookup failed:", err);
  }

  try {
    const fromBq = await searchBigQueryOrgs(q);
    if (fromBq.length > 0) {
      return { orgs: fromBq, source: "bigquery" };
    }
    return {
      orgs: [],
      source: "none",
      note: "No product org matched. Check the name or paste the org uuid.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "BigQuery search failed";
    // Common: credentials missing in env
    return {
      orgs: [],
      source: "none",
      note: /BIGQUERY_CREDENTIALS|credentials/i.test(message)
        ? "Product org search needs BigQuery credentials (or a populated product_signals_latest table)."
        : message,
    };
  }
}
