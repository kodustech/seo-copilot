import { queryBigQuery } from "@/lib/bigquery";

// ---------------------------------------------------------------------------
// Product signals for a CRM company linked to a product org (`org_id`).
//
// Pulls real usage from BigQuery (kodus_postgres / kodus_billing / kodus_mongo)
// so the CRM shows whether an account signed up, is active, or is churning.
// ---------------------------------------------------------------------------

export type ProductHealth = "active" | "cooling" | "at_risk" | "dormant" | "unknown";

export type ProductSignals = {
  orgId: string;
  found: boolean;
  name: string | null;
  tenantName: string | null;
  active: boolean | null; // organizations.status
  signupAt: string | null; // organizations.createdAt
  // Subscription (organization_licenses, latest row)
  subscriptionStatus: string | null;
  planType: string | null;
  trialEnd: string | null;
  totalLicenses: number | null;
  assignedLicenses: number | null;
  // Team
  userCount: number | null;
  // Product usage (pullRequests reviewed)
  lastReviewAt: string | null;
  reviews30d: number | null;
  reviews7d: number | null;
  health: ProductHealth;
};

// org uuids are uuid-shaped; guard against injection since queryBigQuery
// inlines the value (it does not accept bound parameters).
function assertSafeOrgId(orgId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(orgId)) {
    throw new Error("Invalid org_id");
  }
  return orgId;
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// BigQuery returns DATETIME/TIMESTAMP as { value: "..." } objects.
function asIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "value" in v) {
    const inner = (v as { value: unknown }).value;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function deriveHealth(
  found: boolean,
  lastReviewAt: string | null,
  reviews30d: number | null,
): ProductHealth {
  if (!found) return "unknown";
  const d = daysSince(lastReviewAt);
  if (d == null) return "dormant";
  if (d <= 7 || (reviews30d ?? 0) > 0) {
    if (d <= 7) return "active";
    return "cooling";
  }
  if (d <= 30) return "cooling";
  if (d <= 60) return "at_risk";
  return "dormant";
}

export async function getProductSignals(orgId: string): Promise<ProductSignals> {
  const safe = assertSafeOrgId(orgId);

  const empty: ProductSignals = {
    orgId: safe,
    found: false,
    name: null,
    tenantName: null,
    active: null,
    signupAt: null,
    subscriptionStatus: null,
    planType: null,
    trialEnd: null,
    totalLicenses: null,
    assignedLicenses: null,
    userCount: null,
    lastReviewAt: null,
    reviews30d: null,
    reviews7d: null,
    health: "unknown",
  };

  // Single round-trip: one query with scalar subqueries keeps it cheap.
  const sql = `
    SELECT
      o.name AS name,
      o.tenantName AS tenant_name,
      o.status AS active,
      o.createdAt AS signup_at,
      lic.subscriptionStatus AS subscription_status,
      lic.planType AS plan_type,
      lic.trialEnd AS trial_end,
      lic.totalLicenses AS total_licenses,
      lic.assignedLicenses AS assigned_licenses,
      (SELECT COUNT(*) FROM \`kody-408918.kodus_postgres.users\` u
        WHERE u.organization_id = '${safe}') AS user_count,
      (SELECT MAX(SAFE_CAST(pr.createdAt AS TIMESTAMP))
        FROM \`kody-408918.kodus_mongo.pullRequests\` pr
        WHERE pr.organizationId = '${safe}') AS last_review_at,
      (SELECT COUNT(*) FROM \`kody-408918.kodus_mongo.pullRequests\` pr
        WHERE pr.organizationId = '${safe}'
          AND SAFE_CAST(pr.createdAt AS TIMESTAMP) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)) AS reviews_30d,
      (SELECT COUNT(*) FROM \`kody-408918.kodus_mongo.pullRequests\` pr
        WHERE pr.organizationId = '${safe}'
          AND SAFE_CAST(pr.createdAt AS TIMESTAMP) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)) AS reviews_7d
    FROM \`kody-408918.kodus_postgres.organizations\` o
    LEFT JOIN \`kody-408918.kodus_billing.organization_licenses\` lic
      ON lic.organizationId = o.uuid
    WHERE o.uuid = '${safe}'
    ORDER BY lic.updatedAt DESC
    LIMIT 1
  `;

  const { rows } = await queryBigQuery(sql, 1);
  if (!rows.length) return empty;

  const r = rows[0];
  const lastReviewAt = asIso(r.last_review_at);
  const reviews30d = asNumber(r.reviews_30d);
  const reviews7d = asNumber(r.reviews_7d);

  return {
    orgId: safe,
    found: true,
    name: (r.name as string | null) ?? null,
    tenantName: (r.tenant_name as string | null) ?? null,
    active: typeof r.active === "boolean" ? r.active : null,
    signupAt: asIso(r.signup_at),
    subscriptionStatus: (r.subscription_status as string | null) ?? null,
    planType: (r.plan_type as string | null) ?? null,
    trialEnd: asIso(r.trial_end),
    totalLicenses: asNumber(r.total_licenses),
    assignedLicenses: asNumber(r.assigned_licenses),
    userCount: asNumber(r.user_count),
    lastReviewAt,
    reviews30d,
    reviews7d,
    health: deriveHealth(true, lastReviewAt, reviews30d),
  };
}
