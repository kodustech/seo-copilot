import { queryBigQuery } from "@/lib/bigquery";

import type { OrgFacts } from "./classify";
import { classifyDomain } from "./domains";

// ---------------------------------------------------------------------------
// Bulk collector: one BigQuery round-trip returning the raw facts for every
// product org. Knows nothing about tiers — that is classify.ts.
//
// "Reviews" here are successful automation executions (delivered reviews),
// not pullRequests rows: a PR row exists even when every execution on it was
// skipped, which is exactly the population this pipeline needs to see.
// ---------------------------------------------------------------------------

const MAX_ORGS = 10000;

export type OrgContact = {
  email: string;
  name: string | null;
};

export type CollectedOrg = OrgFacts & {
  /** Corporate domain derived from member emails (free-mail excluded). */
  derivedDomain: string | null;
  /** Up to 5 member emails (corporate first) for CRM contact creation. */
  contacts: OrgContact[];
};

function asIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "value" in v) {
    const inner = (v as { value: unknown }).value;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

function asNumber(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/** Most common corporate email domain among members; null when all personal.
 *  Free-mail, academic and internal domains never qualify — see domains.ts. */
export function deriveCompanyDomain(emails: string[]): string | null {
  const counts = new Map<string, number>();
  for (const email of emails) {
    const domain = domainOfEmail(email);
    if (!domain || classifyDomain(domain) !== "corporate") continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}

export async function collectOrgFacts(): Promise<CollectedOrg[]> {
  const sql = `
    WITH latest_lic AS (
      SELECT organizationId, planType, subscriptionStatus, trialEnd,
             totalLicenses, assignedLicenses
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY organizationId ORDER BY updatedAt DESC
        ) AS rn
        FROM \`kody-408918.kodus_billing.organization_licenses\`
      )
      WHERE rn = 1
    ),
    git AS (
      SELECT organization_id,
             CASE
               WHEN LOWER(JSON_VALUE(ANY_VALUE(authDetails HAVING MAX createdAt), '$.accountType')) = 'user'
                 THEN 'user'
               ELSE 'organization'
             END AS org_type
      FROM \`kody-408918.kodus_postgres.auth_integrations\`
      GROUP BY organization_id
    ),
    members AS (
      SELECT organization_id,
             COUNT(*) AS user_count,
             ARRAY_AGG(STRUCT(LOWER(u.email) AS email, p.name AS name)
                       ORDER BY u.createdAt ASC LIMIT 8) AS people
      FROM \`kody-408918.kodus_postgres.users\` u
      LEFT JOIN \`kody-408918.kodus_postgres.profiles\` p ON p.user_id = u.uuid
      WHERE u.email IS NOT NULL
      GROUP BY organization_id
    ),
    execs AS (
      SELECT t.organization_id AS org_id,
             COUNTIF(ae.status = 'success'
                     AND ae.createdAt >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 7 DAY)) AS reviews_7d,
             COUNTIF(ae.status = 'success'
                     AND ae.createdAt >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 30 DAY)) AS reviews_30d,
             MAX(IF(ae.status = 'success', ae.createdAt, NULL)) AS last_review_at,
             COUNTIF(ae.status = 'skipped'
                     AND ae.createdAt >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 30 DAY)) AS skips_30d
      FROM \`kody-408918.kodus_postgres.automation_execution\` ae
      JOIN \`kody-408918.kodus_postgres.team_automations\` ta ON ae.team_automation_id = ta.uuid
      JOIN \`kody-408918.kodus_postgres.teams\` t ON ta.teamUuid = t.uuid
      GROUP BY 1
    ),
    pr_authors AS (
      -- Distinct humans who opened a PR Kodus processed. Fallback team size for
      -- orgs onboarded before code_host_member_count existed (2026-07-28).
      -- Undercounts by construction: only devs whose PRs we actually saw.
      SELECT organizationId AS org_id,
             COUNT(DISTINCT author) AS pr_author_count
      FROM (
        SELECT organizationId,
               COALESCE(
                 JSON_VALUE(user, '$.username'),
                 JSON_VALUE(user, '$.name')
               ) AS author
        FROM \`kody-408918.kodus_mongo.pullRequests\`
        WHERE user IS NOT NULL
      )
      WHERE author IS NOT NULL
        AND TRIM(author) != ''
        -- \\b around the bare "bot" only: unanchored it also swallows real
        -- people (botelho, robot, mobot), and this count is the sole team-size
        -- signal for orgs predating code_host_member_count, so an undercount
        -- pushes them below MIN_DEVS. The named bots keep matching anywhere,
        -- and "_token" stays unanchored on purpose — it appears mid-word in
        -- service accounts like BITBUCKET_ACCESS_TOKEN, where \\b would not
        -- match between "s" and "_".
        AND NOT REGEXP_CONTAINS(LOWER(author), r'(\\bbot\\b|dependabot|renovate|github-actions|snyk|_token|\\[bot\\])')
      GROUP BY 1
    ),
    top_skips AS (
      SELECT org_id, reason AS top_skip_reason
      FROM (
        SELECT t.organization_id AS org_id,
               COALESCE(ae.errorMessage, '(none)') AS reason,
               COUNT(*) AS n,
               ROW_NUMBER() OVER (
                 PARTITION BY t.organization_id ORDER BY COUNT(*) DESC
               ) AS rn
        FROM \`kody-408918.kodus_postgres.automation_execution\` ae
        JOIN \`kody-408918.kodus_postgres.team_automations\` ta ON ae.team_automation_id = ta.uuid
        JOIN \`kody-408918.kodus_postgres.teams\` t ON ta.teamUuid = t.uuid
        WHERE ae.status = 'skipped'
          AND ae.createdAt >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 30 DAY)
        GROUP BY 1, 2
      )
      WHERE rn = 1
    )
    SELECT
      o.uuid AS org_id,
      o.name AS org_name,
      o.createdAt AS signup_at,
      git.org_type AS org_type,
      git.organization_id IS NOT NULL AS connected_git,
      lic.planType AS plan_type,
      lic.subscriptionStatus AS subscription_status,
      lic.trialEnd AS trial_end,
      lic.totalLicenses AS total_licenses,
      lic.assignedLicenses AS assigned_licenses,
      members.user_count AS user_count,
      members.people AS people,
      COALESCE(execs.reviews_7d, 0) AS reviews_7d,
      COALESCE(execs.reviews_30d, 0) AS reviews_30d,
      execs.last_review_at AS last_review_at,
      COALESCE(execs.skips_30d, 0) AS skips_30d,
      top_skips.top_skip_reason AS top_skip_reason,
      o.code_host_member_count AS code_host_member_count,
      o.code_host_member_count_updated_at AS code_host_member_count_at,
      pr_authors.pr_author_count AS pr_author_count
    FROM \`kody-408918.kodus_postgres.organizations\` o
    LEFT JOIN latest_lic lic ON lic.organizationId = o.uuid
    LEFT JOIN git ON git.organization_id = o.uuid
    LEFT JOIN members ON members.organization_id = o.uuid
    LEFT JOIN execs ON execs.org_id = o.uuid
    LEFT JOIN top_skips ON top_skips.org_id = o.uuid
    LEFT JOIN pr_authors ON pr_authors.org_id = o.uuid
    LIMIT ${MAX_ORGS}
  `;

  const { rows } = await queryBigQuery(sql, MAX_ORGS);

  return rows.map((r) => {
    const rawPeople = Array.isArray(r.people)
      ? (r.people as Array<{ email?: unknown; name?: unknown }>)
      : [];
    const emails: string[] = [];
    const contacts: OrgContact[] = [];
    for (const p of rawPeople) {
      const email = typeof p.email === "string" ? p.email.trim() : "";
      if (!email || !email.includes("@")) continue;
      emails.push(email);
      contacts.push({
        email,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null,
      });
    }

    const derivedDomain = deriveCompanyDomain(emails);
    // Corporate contacts first, cap at 5.
    contacts.sort((a, b) => {
      const aCorp = derivedDomain && domainOfEmail(a.email) === derivedDomain ? 0 : 1;
      const bCorp = derivedDomain && domainOfEmail(b.email) === derivedDomain ? 0 : 1;
      return aCorp - bCorp;
    });

    const orgType = r.org_type === "user" ? "user" : r.org_type === "organization" ? "organization" : null;

    return {
      orgId: String(r.org_id),
      orgName: (r.org_name as string | null) ?? null,
      orgType,
      signupAt: asIso(r.signup_at),
      connectedGit: r.connected_git === true,
      planType: (r.plan_type as string | null) ?? null,
      subscriptionStatus: (r.subscription_status as string | null) ?? null,
      trialEnd: asIso(r.trial_end),
      totalLicenses: asNumberOrNull(r.total_licenses),
      assignedLicenses: asNumberOrNull(r.assigned_licenses),
      userCount: asNumberOrNull(r.user_count),
      reviews7d: asNumber(r.reviews_7d),
      reviews30d: asNumber(r.reviews_30d),
      lastReviewAt: asIso(r.last_review_at),
      skips30d: asNumber(r.skips_30d),
      // Blank counts as absent, same contract as lib/crm-signals.ts. Callers
      // check this for truthiness to decide whether there is a reason worth
      // naming, and an empty string passes a null check while naming nothing.
      topSkipReason:
        typeof r.top_skip_reason === "string" &&
        r.top_skip_reason !== "(none)" &&
        r.top_skip_reason.trim().length > 0
          ? r.top_skip_reason
          : null,
      codeHostMemberCount: asNumberOrNull(r.code_host_member_count),
      codeHostMemberCountAt: asIso(r.code_host_member_count_at),
      prAuthorCount: asNumberOrNull(r.pr_author_count),
      derivedDomain,
      contacts: contacts.slice(0, 5),
    };
  });
}
