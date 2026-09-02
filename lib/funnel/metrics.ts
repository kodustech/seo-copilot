import type { SupabaseClient } from "@supabase/supabase-js";

import { queryBigQuery } from "@/lib/bigquery";
import { fetchOutboundMetrics } from "@/lib/outreach/metrics";
import { isTelemetryConfigured, runTelemetryQuery } from "@/lib/telemetry-pg";

import {
  BOTTLENECK_RATIO,
  COLD_MIN_CONTACTS_FOR_VERDICT,
  COLD_SEQUENCE_PATTERNS,
  FREE_MAIL_DOMAINS,
  HEAD_TERMS,
  ICP_MIN_AUTHORS,
  ICP_MIN_MEMBERS,
  ICP_VERIFIED_FIELD,
  LLM_SOURCES,
  MAX_BOTTLENECKS,
  OPPORTUNITY_IDLE_DAYS,
  OPPORTUNITY_STATUSES,
  QUALIFIED_PAGES,
  RATE_BANDS,
  SELF_HOSTED_ACTIVE_DAYS,
  SELF_HOSTED_MIN_PRS_7D,
  TARGETS,
} from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FunnelCell = string | number | boolean | null;
export type FunnelRow = Record<string, FunnelCell>;

export type FunnelNode = {
  id: string;
  title: string;
  /** null = not measured (no source, or source not configured). */
  value: number | null;
  /** Second line inside the box. */
  display: string;
  target: number | null;
  /** Where the number comes from, shown in the drawer. */
  source: string;
  /** Definition in one sentence, shown in the drawer. */
  definition: string;
  columns: string[];
  rows: FunnelRow[];
};

export type RateStatus = "good" | "ok" | "warn" | "crit" | "na";

/** A rate between two stages, judged against a market band when one exists. */
export type FunnelRate = {
  id: string;
  /** Text for the arrow, already formatted. */
  label: string;
  value: number | null;
  status: RateStatus;
  /** Why it got that status (band, or "não medido"). */
  note: string;
};

/** A red marker: the stage furthest from what the month needs. */
export type Bottleneck = {
  nodeId: string;
  lines: string[];
};

export type FunnelData = {
  month: string;
  periodStart: string;
  periodEnd: string;
  /** Share of the month elapsed (1 for a closed month). Targets are pro-rated by it. */
  elapsed: number;
  generatedAt: string;
  nodes: Record<string, FunnelNode>;
  /** Free-form facts for the arrow labels (breakdowns). */
  facts: Record<string, string>;
  rates: FunnelRate[];
  bottlenecks: Bottleneck[];
  errors: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BQ = "kody-408918";

function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "value" in v) {
    return Number((v as { value: unknown }).value ?? 0);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && "value" in v) {
    return String((v as { value: unknown }).value ?? "");
  }
  return String(v);
}

function pct(part: number, whole: number): string {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function sqlList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ");
}

/** Resolve "YYYY-MM" to an inclusive day range, capped at today. */
export function monthRange(month: string): {
  periodStart: string;
  periodEnd: string;
  nextStart: string;
  elapsed: number;
} {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid month: ${month}`);
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m, 1));
  const today = new Date();
  const lastDay = new Date(next.getTime() - 24 * 60 * 60 * 1000);
  const end = lastDay > today ? today : lastDay;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const daysInMonth = Math.round((next.getTime() - start.getTime()) / 86_400_000);
  const daysElapsed = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const elapsed = Math.min(1, Math.max(1 / daysInMonth, daysElapsed / daysInMonth));
  return { periodStart: iso(start), periodEnd: iso(end), nextStart: iso(next), elapsed };
}

/** Judge a fraction against a market band. */
function judge(id: string, value: number | null): { status: RateStatus; note: string } {
  if (value == null) return { status: "na", note: "não medido" };
  const band = RATE_BANDS[id];
  if (!band) return { status: "ok", note: "" };
  const fmt = (x: number) => `${Math.round(x * 100)}%`;
  const ref = band.lo === band.hi ? `mercado: ${fmt(band.lo)}` : `mercado ${fmt(band.lo)} a ${fmt(band.hi)}`;
  if (band.inverted) {
    if (value <= band.hi) return { status: "good", note: `${ref} ou menos` };
    if (value <= band.hi * 3) return { status: "warn", note: `acima do ${ref}` };
    return { status: "crit", note: `muito acima do ${ref}` };
  }
  if (value < band.lo) return { status: "warn", note: `abaixo do ${ref}` };
  if (value > band.hi) {
    return band.loose
      ? { status: "warn", note: `acima do ${ref}: definição frouxa` }
      : { status: "good", note: `acima do ${ref}` };
  }
  return { status: "ok", note: `no ${ref}` };
}

function rate(id: string, label: string, part: number | null, whole: number | null, nullLabel?: string): FunnelRate {
  const value = part == null || whole == null || whole === 0 ? null : part / whole;
  const { status, note } = judge(id, value);
  return { id, label: value == null && nullLabel ? nullLabel : label, value, status, note };
}

function node(
  id: string,
  title: string,
  value: number | null,
  display: string,
  extra: Partial<FunnelNode> = {},
): FunnelNode {
  return {
    id,
    title,
    value,
    display,
    target: TARGETS[id] ?? null,
    source: "",
    definition: "",
    columns: [],
    rows: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function searchNodes(
  periodStart: string,
  periodEnd: string,
): Promise<{ impressions: FunnelNode; visits: FunnelNode; facts: Record<string, string> }> {
  const sql = `
    SELECT page,
      SUM(impressions) AS impressions,
      SUM(clicks) AS clicks,
      SAFE_DIVIDE(SUM(position * impressions), SUM(impressions)) AS position
    FROM \`${BQ}.kodus_search_console.search_analytics_by_page\`
    WHERE date BETWEEN '${periodStart}' AND '${periodEnd}'
      AND search_type = 'web'
      AND page IN (${sqlList(QUALIFIED_PAGES)})
    GROUP BY page
    ORDER BY impressions DESC
    LIMIT 100`;
  const { rows } = await queryBigQuery(sql, 100);
  const pages = rows.map((r) => ({
    page: str(r.page) ?? "",
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    position: Math.round(num(r.position) * 10) / 10,
  }));
  const impressions = pages.reduce((s, p) => s + p.impressions, 0);
  const clicks = pages.reduce((s, p) => s + p.clicks, 0);
  const wpos = impressions
    ? pages.reduce((s, p) => s + p.position * p.impressions, 0) / impressions
    : 0;

  const headSql = `
    SELECT query, page,
      SUM(impressions) AS impressions, SUM(clicks) AS clicks,
      SAFE_DIVIDE(SUM(position * impressions), SUM(impressions)) AS position
    FROM \`${BQ}.kodus_search_console.search_analytics_all_fields\`
    WHERE date BETWEEN '${periodStart}' AND '${periodEnd}'
      AND search_type = 'web'
      AND LOWER(query) IN (${sqlList(HEAD_TERMS)})
    GROUP BY query, page
    ORDER BY impressions DESC
    LIMIT 50`;
  let headRows: FunnelRow[] = [];
  try {
    const head = await queryBigQuery(headSql, 50);
    headRows = head.rows.map((r) => ({
      query: str(r.query),
      page: (str(r.page) ?? "").replace(/^https:\/\/(www\.)?kodus\.io/, ""),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      position: Math.round(num(r.position) * 10) / 10,
    }));
  } catch {
    headRows = [];
  }

  const pageRows: FunnelRow[] = pages.map((p) => ({
    page: p.page.replace(/^https:\/\//, ""),
    impressions: p.impressions,
    clicks: p.clicks,
    ctr: pct(p.clicks, p.impressions),
    position: p.position,
  }));

  const impressionsNode = node(
    "impressions",
    `Impressões nas ${QUALIFIED_PAGES.length} páginas (Google)`,
    impressions,
    `${impressions.toLocaleString("pt-BR")} · posição média ${wpos.toFixed(1)}`,
    {
      source: "Google Search Console (BigQuery kodus_search_console.search_analytics_by_page)",
      definition:
        "Impressões e posição média ponderada das páginas de intenção. A média é puxada pelas páginas genéricas; olhe a posição por página e por termo.",
      columns: ["page", "impressions", "clicks", "ctr", "position"],
      rows: pageRows,
    },
  );
  const visitsNode = node(
    "visits",
    `Visitas qualificadas (${QUALIFIED_PAGES.length} páginas)`,
    clicks,
    `${clicks.toLocaleString("pt-BR")} cliques`,
    {
      source: "Google Search Console, cliques por página",
      definition: "Cliques do Google nas páginas de intenção. Não inclui referral de LLM nem tráfego direto.",
      columns: ["query", "page", "impressions", "clicks", "position"],
      rows: headRows,
    },
  );
  return {
    impressions: impressionsNode,
    visits: visitsNode,
    facts: { ctr: `CTR ${pct(clicks, impressions)}` },
  };
}

async function llmReferralNode(periodStart: string, periodEnd: string): Promise<FunnelNode> {
  const sql = `
    WITH dedup AS (
      SELECT date, sessionSource, sessionMedium, property_id,
        MAX(totalUsers) AS users, MAX(sessions) AS sessions
      FROM \`${BQ}.kodus_ga.traffic_sources\`
      -- GA4 export stores date as a 'YYYYMMDD' string.
      WHERE date BETWEEN '${periodStart.replace(/-/g, "")}' AND '${periodEnd.replace(/-/g, "")}'
        AND LOWER(sessionSource) IN (${sqlList(LLM_SOURCES)})
      GROUP BY date, sessionSource, sessionMedium, property_id
    )
    SELECT sessionSource AS source, CAST(property_id AS STRING) AS property_id,
      SUM(users) AS users, SUM(sessions) AS sessions
    FROM dedup GROUP BY source, property_id ORDER BY users DESC LIMIT 50`;
  try {
    const { rows } = await queryBigQuery(sql, 50);
    const users = rows.reduce((s, r) => s + num(r.users), 0);
    return node(
      "llm_referral",
      "Referral de LLM (ChatGPT, Claude, Perplexity)",
      users,
      `${users} usuários (GA4)`,
      {
        source: "GA4 (BigQuery kodus_ga.traffic_sources), sessionSource",
        definition:
          "Usuários cuja sessão veio de um assistente de IA, em qualquer página. Não entram nas visitas qualificadas, que contam só Google.",
        columns: ["source", "property_id", "users", "sessions"],
        rows: rows.map((r) => ({
          source: str(r.source),
          property_id: str(r.property_id),
          users: num(r.users),
          sessions: num(r.sessions),
        })),
      },
    );
  } catch (err) {
    return node("llm_referral", "Referral de LLM", null, "não medido", {
      source: `GA4: ${err instanceof Error ? err.message : "erro"}`,
    });
  }
}

type SignupRow = {
  org_id: string;
  name: string;
  domain: string;
  corporate: boolean;
  created: string;
  platform: string | null;
  members: number | null;
  authors: number;
  survey_source: string | null;
  plan: string | null;
  icp: boolean;
};

async function signupRows(periodStart: string, nextStart: string): Promise<SignupRow[]> {
  const sql = `
    WITH owner AS (
      SELECT u.organization_id, u.email,
        ROW_NUMBER() OVER (PARTITION BY u.organization_id ORDER BY u.createdAt) AS rn,
        p.referralSource
      FROM \`${BQ}.kodus_postgres.users\` u
      LEFT JOIN \`${BQ}.kodus_postgres.profiles\` p ON p.user_id = u.uuid
    ),
    plat AS (
      SELECT organization_id, STRING_AGG(DISTINCT platform ORDER BY platform) AS platforms
      FROM \`${BQ}.kodus_postgres.integrations\`
      WHERE integrationCategory = 'CODE_MANAGEMENT'
      GROUP BY organization_id
    ),
    authors AS (
      SELECT organizationId AS org_id, COUNT(DISTINCT author_username) AS authors
      FROM \`${BQ}.kodus_postgres_analytics.pull_requests_opt\`
      GROUP BY organizationId
    ),
    lic AS (
      SELECT organizationId, STRING_AGG(DISTINCT planType) AS plans
      FROM \`${BQ}.kodus_billing.organization_licenses\`
      GROUP BY organizationId
    )
    SELECT o.uuid AS org_id, o.name, DATE(o.createdAt) AS created,
      REGEXP_EXTRACT(LOWER(ow.email), r'@(.+)$') AS domain,
      ow.referralSource AS survey_source,
      pl.platforms, o.code_host_member_count AS members,
      COALESCE(a.authors, 0) AS authors, l.plans
    FROM \`${BQ}.kodus_postgres.organizations\` o
    LEFT JOIN owner ow ON ow.organization_id = o.uuid AND ow.rn = 1
    LEFT JOIN plat pl ON pl.organization_id = o.uuid
    LEFT JOIN authors a ON a.org_id = o.uuid
    LEFT JOIN lic l ON l.organizationId = o.uuid
    WHERE o.createdAt >= '${periodStart}' AND o.createdAt < '${nextStart}'
    ORDER BY o.createdAt DESC
    LIMIT 500`;
  const { rows } = await queryBigQuery(sql, 500);
  const free = new Set(FREE_MAIL_DOMAINS);
  return rows.map((r) => {
    const domain = str(r.domain) ?? "";
    const members = r.members == null ? null : num(r.members);
    const authors = num(r.authors);
    const icp =
      (members != null && members > 0 && members >= ICP_MIN_MEMBERS) ||
      authors >= ICP_MIN_AUTHORS;
    return {
      org_id: str(r.org_id) ?? "",
      name: str(r.name) ?? "",
      domain,
      corporate: domain !== "" && !free.has(domain),
      created: str(r.created) ?? "",
      platform: str(r.platforms),
      members,
      authors,
      survey_source: str(r.survey_source),
      plan: str(r.plans),
      icp,
    };
  });
}

type CrmCompanyLite = {
  id: string;
  name: string;
  domain: string | null;
  org_id: string | null;
  status: string;
  arr: number | null;
  dev_count: number | null;
  deployment: string | null;
  source: string | null;
  tier: string | null;
  trigger: string | null;
  properties: Record<string, unknown> | null;
  last_activity_at: string | null;
  last_outreach_at: string | null;
  created_at: string;
};

async function loadCompanies(client: SupabaseClient): Promise<CrmCompanyLite[]> {
  const { data, error } = await client
    .from("crm_companies")
    .select(
      "id,name,domain,org_id,status,arr,dev_count,deployment,source,tier,trigger,properties,last_activity_at,last_outreach_at,created_at",
    )
    .is("archived_at", null)
    .limit(5000);
  if (error) throw new Error(`crm_companies: ${error.message}`);
  return (data ?? []).map((r) => ({
    ...(r as Record<string, unknown>),
    arr: r.arr == null ? null : Number(r.arr),
    dev_count: r.dev_count == null ? null : Number(r.dev_count),
  })) as CrmCompanyLite[];
}

type StatusChange = {
  company_id: string;
  kind: string;
  actor: string | null;
  from: string | null;
  to: string | null;
  created_at: string;
};

/** Kinds that mean a person did something on the account. */
const HUMAN_KINDS = ["status_change", "comment", "note", "outreach_sent"];

async function loadActivities(
  client: SupabaseClient,
  periodStart: string,
  nextStart: string,
): Promise<StatusChange[]> {
  // Two extra days after the period so a signup on the 31st can still count
  // as touched within 48 h.
  const until = new Date(new Date(`${nextStart}T00:00:00Z`).getTime() + 2 * 24 * 60 * 60 * 1000)
    .toISOString();
  const { data, error } = await client
    .from("crm_activities")
    .select("company_id,kind,actor_email,meta,created_at")
    .in("kind", HUMAN_KINDS)
    .gte("created_at", `${periodStart}T00:00:00Z`)
    .lt("created_at", until)
    .order("created_at", { ascending: true })
    .limit(10000);
  if (error) throw new Error(`crm_activities: ${error.message}`);
  return (data ?? []).map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    return {
      company_id: r.company_id as string,
      kind: r.kind as string,
      actor: (r.actor_email as string | null) ?? null,
      from: (meta.from as string | undefined) ?? null,
      to: (meta.to as string | undefined) ?? null,
      created_at: r.created_at as string,
    };
  });
}

function isVerified(props: Record<string, unknown> | null): boolean {
  const v = props?.[ICP_VERIFIED_FIELD];
  return v === true || v === "true" || v === "yes" || v === "sim";
}

async function hasVerifiedField(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client
    .from("crm_field_defs")
    .select("key")
    .eq("key", ICP_VERIFIED_FIELD)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

async function coldOutbound(
  client: SupabaseClient,
  periodStart: string,
  nextStart: string,
): Promise<{
  contacts: FunnelNode;
  replies: FunnelNode;
  facts: Record<string, string>;
  counts: { people: number; bounced: number; completed: number; humanReplies: number | null } | null;
}> {
  const { data: seqs, error } = await client
    .from("outreach_sequences")
    .select("id,name,status");
  if (error) throw new Error(`outreach_sequences: ${error.message}`);
  const cold = (seqs ?? []).filter((s) =>
    COLD_SEQUENCE_PATTERNS.some((re) => re.test(String(s.name))),
  );
  const coldIds = cold.map((s) => s.id as string);
  if (coldIds.length === 0) {
    return {
      contacts: node("ob_contacts", "Contatos novos (cold)", null, "nenhuma sequência cold"),
      replies: node("ob_replies", "Respostas de empresa nova", null, "não medido"),
      facts: {},
      counts: null,
    };
  }

  const { data: enr, error: enrErr } = await client
    .from("outreach_enrollments")
    .select(
      "id,sequence_id,status,company_name,domain,contact_name,contact_email,current_step_position,created_at",
    )
    .in("sequence_id", coldIds)
    .gte("created_at", `${periodStart}T00:00:00Z`)
    .lt("created_at", `${nextStart}T00:00:00Z`)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (enrErr) throw new Error(`outreach_enrollments: ${enrErr.message}`);
  const enrollments = enr ?? [];
  const seqName = new Map(cold.map((s) => [s.id as string, String(s.name)]));

  const people = enrollments.length;
  const companies = new Set(
    enrollments.map((e) => String(e.domain ?? e.company_name ?? "").toLowerCase()),
  ).size;
  const byStatus = (s: string) => enrollments.filter((e) => e.status === s).length;
  const completed = byStatus("completed");
  const bounced = byStatus("bounced");
  const repliedStatus = byStatus("replied");

  // Human replies come from the outbound_metrics RPC (it classifies threads);
  // the enrollment status "replied" also counts auto-replies and bounces.
  let humanReplies: number | null = null;
  try {
    const since = new Date(`${periodStart}T00:00:00Z`);
    const until = new Date(`${nextStart}T00:00:00Z`);
    let sum = 0;
    for (const id of coldIds) {
      const m = await fetchOutboundMetrics(client, { since, until, sequenceId: id });
      sum += num(m.humanReplies);
    }
    humanReplies = sum;
  } catch {
    humanReplies = null;
  }

  const rows: FunnelRow[] = enrollments.map((e) => ({
    company: str(e.company_name),
    domain: str(e.domain),
    contact: str(e.contact_name),
    email: str(e.contact_email),
    sequence: seqName.get(String(e.sequence_id)) ?? null,
    status: str(e.status),
    step: num(e.current_step_position),
    enrolled: String(e.created_at).slice(0, 10),
  }));

  const contacts = node(
    "ob_contacts",
    "Contatos novos (cold)",
    people,
    `${people} pessoas · ${companies} empresas`,
    {
      source: `Motor de sequência: ${cold.map((s) => s.name).join("; ")}`,
      definition:
        "Pessoas enroladas nas sequências cold no mês. Só empresa que não está no produto.",
      columns: ["company", "contact", "email", "sequence", "status", "step", "enrolled"],
      rows,
    },
  );
  // Replies are counted at the enrollment (status "replied", set by the email
  // and LinkedIn inbox syncs). Bounces get their own status, so they never
  // land here; an email autoresponder can, until the classifier runs.
  const replies = node(
    "ob_replies",
    "Respostas de empresa nova",
    repliedStatus,
    `cold: ${repliedStatus}${humanReplies != null && humanReplies !== repliedStatus ? ` · classificadas humanas: ${humanReplies}` : ""}`,
    {
      source: "Motor de sequência (enrollments com status replied; e-mail e LinkedIn)",
      definition:
        "Pessoas de sequência cold que responderam, por e-mail ou LinkedIn. Bounce não entra. Rede (indicação, champion) não passa pelo motor e é registrada no CRM.",
      columns: ["company", "contact", "sequence", "status", "step", "enrolled"],
      rows: rows.filter((r) => r.status === "replied"),
    },
  );
  return {
    contacts,
    replies,
    facts: {
      ob_completed: `${pct(completed + repliedStatus, people)} completaram`,
    },
    counts: { people, bounced, completed: completed + repliedStatus, humanReplies: repliedStatus },
  };
}

async function selfHostedInstances(): Promise<FunnelNode> {
  if (!isTelemetryConfigured()) {
    return node("sh_instances", "Instâncias com uso de empresa", null, "telemetria não configurada");
  }
  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (instance_id) instance_id, received_at, payload
      FROM telemetry_heartbeats
      WHERE received_at >= now() - interval '${SELF_HOSTED_ACTIVE_DAYS} days'
      ORDER BY instance_id, received_at DESC
    )
    SELECT instance_id,
      payload->'kodus'->>'version' AS version,
      payload->'config'->'integrations' AS integrations,
      (payload->'usage_7d'->>'prs_reviewed')::int AS prs_7d,
      (payload->'usage_7d'->>'active_users')::int AS users_7d,
      (payload->'usage_7d'->>'repos_connected')::int AS repos,
      received_at
    FROM latest
    WHERE (payload->'usage_7d'->>'prs_reviewed')::int >= ${SELF_HOSTED_MIN_PRS_7D}
    ORDER BY prs_7d DESC
    LIMIT 200`;
  try {
    const res = await runTelemetryQuery({ sql, maxRows: 200 });
    const rows = (res.rows as Record<string, unknown>[]).map((r) => ({
      instance: String(r.instance_id).slice(0, 8),
      version: str(r.version),
      integrations: Array.isArray(r.integrations) ? (r.integrations as string[]).join(", ") : str(r.integrations),
      prs_7d: num(r.prs_7d),
      users_7d: num(r.users_7d),
      repos: num(r.repos),
      last_seen: String(r.received_at).slice(0, 10),
    }));
    return node(
      "sh_instances",
      "Instâncias com uso de empresa",
      rows.length,
      `${rows.length} ativas nos últimos ${SELF_HOSTED_ACTIVE_DAYS} dias`,
      {
        source: "Telemetria self-hosted (anônima)",
        definition: `Instâncias com heartbeat nos últimos ${SELF_HOSTED_ACTIVE_DAYS} dias e ≥ ${SELF_HOSTED_MIN_PRS_7D} PRs revisados em 7 dias. Anônimas: não dá pra saber a empresa.`,
        columns: ["instance", "version", "integrations", "prs_7d", "users_7d", "repos", "last_seen"],
        rows,
      },
    );
  } catch (err) {
    return node("sh_instances", "Instâncias com uso de empresa", null, "não medido", {
      source: `Telemetria: ${err instanceof Error ? err.message : "erro"}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

export async function fetchFunnel(client: SupabaseClient, month: string): Promise<FunnelData> {
  const { periodStart, periodEnd, nextStart, elapsed } = monthRange(month);
  const errors: string[] = [];
  const facts: Record<string, string> = {};
  const nodes: Record<string, FunnelNode> = {};
  const rates: FunnelRate[] = [];

  const settle = async <T,>(label: string, p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const [search, llm, signups, companies, changes, verifiedField, cold, sh] =
    await Promise.all([
      settle("search", searchNodes(periodStart, periodEnd)),
      settle("llm", llmReferralNode(periodStart, periodEnd)),
      settle("signups", signupRows(periodStart, nextStart)),
      settle("crm", loadCompanies(client)),
      settle("crm_activities", loadActivities(client, periodStart, nextStart)),
      settle("crm_field", hasVerifiedField(client)),
      settle("outbound", coldOutbound(client, periodStart, nextStart)),
      settle("telemetry", selfHostedInstances()),
    ]);

  // Search
  if (search) {
    nodes.impressions = search.impressions;
    nodes.visits = search.visits;
    rates.push(rate("ctr", `CTR ${pct(search.visits.value ?? 0, search.impressions.value ?? 0)}`, search.visits.value, search.impressions.value, "CTR"));
  } else {
    rates.push(rate("ctr", "CTR", null, null));
    nodes.impressions = node("impressions", "Impressões", null, "não medido");
    nodes.visits = node("visits", "Visitas qualificadas", null, "não medido");
  }
  nodes.llm_referral = llm ?? node("llm_referral", "Referral de LLM", null, "não medido");

  // Signups → connected → ICP
  const all = signups ?? [];
  const corporate = all.filter((s) => s.corporate);
  const connected = corporate.filter((s) => s.platform);
  const icpProxy = corporate.filter((s) => s.icp);
  const signupCols = ["name", "domain", "created", "platform", "members", "authors", "survey_source", "plan", "icp"];
  const toRow = (s: SignupRow): FunnelRow => ({
    name: s.name,
    domain: s.domain,
    created: s.created,
    platform: s.platform,
    members: s.members,
    authors: s.authors,
    survey_source: s.survey_source,
    plan: s.plan,
    icp: s.icp,
  });

  nodes.signups = node(
    "signups",
    "Cadastros com e-mail corporativo",
    signups ? corporate.length : null,
    signups ? `${corporate.length} (${all.length} no total)` : "não medido",
    {
      source: "Produto (BigQuery kodus_postgres.organizations + users)",
      definition:
        "Organizações criadas no mês cujo primeiro usuário tem e-mail que não é de provedor gratuito. O total inclui gmail e afins.",
      columns: signupCols,
      rows: all.map(toRow),
    },
  );
  nodes.connected = node(
    "connected",
    "Conectados",
    signups ? connected.length : null,
    signups ? `${connected.length}` : "não medido",
    {
      source: "Produto (integrations, CODE_MANAGEMENT)",
      definition: "Cadastros corporativos do mês que conectaram um git (GitHub, GitLab, Bitbucket, Azure Repos).",
      columns: signupCols,
      rows: connected.map(toRow),
    },
  );

  const byPlatform: Record<string, { n: number; icp: number }> = {};
  for (const s of connected) {
    const key = s.platform ?? "?";
    byPlatform[key] ??= { n: 0, icp: 0 };
    byPlatform[key].n += 1;
    if (s.icp) byPlatform[key].icp += 1;
  }
  const nonGithub = connected.filter((s) => s.platform && s.platform !== "GITHUB");
  // Clicks and signups are different populations (signups come from every
  // source), so there is no measured visit → signup rate until the signup
  // carries its landing page.
  rates.push(rate("visit_to_signup", "visita → cadastro", null, null));
  rates.push(
    rate("connected", signups ? `${pct(connected.length, corporate.length)} conectam o git` : "conectam o git", signups ? connected.length : null, signups ? corporate.length : null, "conectam o git"),
  );
  rates.push(
    rate(
      "icp_share",
      signups ? `${pct(icpProxy.length, connected.length)} passam o proxy (${icpProxy.length} de ${connected.length})` : "passam o proxy",
      signups ? icpProxy.length : null,
      signups ? connected.length : null,
      "passam o proxy",
    ),
  );
  facts.platform_split = Object.entries(byPlatform)
    .filter(([, v]) => v.n >= 2 || v.icp > 0)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${k.replace("AZURE_REPOS", "Azure").replace("GITHUB", "GitHub").replace("GITLAB", "GitLab").replace("BITBUCKET", "Bitbucket")} ${v.icp}/${v.n}`)
    .join(" · ");
  facts.non_github = `não-GitHub: ${nonGithub.length} cadastros, ${nonGithub.filter((s) => s.icp).length} ICP`;
  const icpFreeMail = all.filter((s) => s.icp && !s.corporate);
  facts.icp_free_mail = icpFreeMail.length
    ? `+${icpFreeMail.length} ICP com e-mail gratuito, fora da conta`
    : "";
  const answered = all.filter((s) => s.survey_source).length;
  rates.push(rate("survey", signups ? `survey respondido: ${pct(answered, all.length)}` : "survey respondido", signups ? answered : null, signups ? all.length : null, "survey respondido"));

  // ICP: proxy from product, verified from the CRM field when it exists.
  const crm = companies ?? [];
  const byOrg = new Map(crm.filter((c) => c.org_id).map((c) => [c.org_id as string, c]));
  const verifiedRows = icpProxy.filter((s) => isVerified(byOrg.get(s.org_id)?.properties ?? null));
  const verifiedMeasured = Boolean(verifiedField);
  nodes.icp = node(
    "icp",
    `ICP (${ICP_MIN_MEMBERS}+ devs)`,
    verifiedMeasured ? verifiedRows.length : icpProxy.length,
    verifiedMeasured
      ? `${verifiedRows.length} verificados · ${icpProxy.length} pelo proxy`
      : `${icpProxy.length} pelo proxy · sem verificação`,
    {
      source: verifiedMeasured
        ? `Produto (proxy) + CRM campo ${ICP_VERIFIED_FIELD}`
        : "Produto (proxy: membros da org no git ou autores de PR)",
      definition: verifiedMeasured
        ? `Proxy: ≥ ${ICP_MIN_MEMBERS} membros na org do git ou ≥ ${ICP_MIN_AUTHORS} autores de PR. Verificado: alguém conferiu no LinkedIn e marcou ${ICP_VERIFIED_FIELD} = yes no CRM.`
        : `Proxy: ≥ ${ICP_MIN_MEMBERS} membros na org do git ou ≥ ${ICP_MIN_AUTHORS} autores de PR. Pra contar verificado, crie o campo ${ICP_VERIFIED_FIELD} (yes/no) no CRM e marque depois de conferir no LinkedIn.`,
      columns: [...signupCols, "crm_status", "verified"],
      rows: icpProxy.map((s) => ({
        ...toRow(s),
        crm_status: byOrg.get(s.org_id)?.status ?? null,
        verified: isVerified(byOrg.get(s.org_id)?.properties ?? null),
      })),
    },
  );

  // CRM: conversations, opportunities, closed
  const byId = new Map(crm.map((c) => [c.id, c]));
  const allActs = changes ?? [];
  const ch = allActs.filter((c) => c.kind === "status_change" && c.created_at < `${nextStart}T00:00:00Z`);

  // Human touch on ICP within 48 h of signup: any activity a person logged on
  // the linked CRM account (comment, note, outreach sent, status moved).
  const touched = icpProxy.filter((s) => {
    const c = byOrg.get(s.org_id);
    if (!c) return false;
    const created = new Date(`${s.created}T00:00:00Z`).getTime();
    return allActs.some((a) => {
      if (a.company_id !== c.id) return false;
      if (a.kind === "status_change" && !a.actor) return false;
      const t = new Date(a.created_at).getTime();
      return t >= created && t - created <= 48 * 60 * 60 * 1000;
    });
  });
  rates.push(
    rate(
      "touch_48h",
      signups ? `toque humano em 48 h: ${touched.length} de ${icpProxy.length} (atividade no CRM)` : "toque humano em 48 h",
      signups ? touched.length : null,
      signups ? icpProxy.length : null,
      "toque humano em 48 h",
    ),
  );
  const opp = new Set<string>(OPPORTUNITY_STATUSES);
  const firstTo = (pred: (c: StatusChange) => boolean) => {
    const seen = new Map<string, StatusChange>();
    for (const c of ch) if (pred(c) && !seen.has(c.company_id)) seen.set(c.company_id, c);
    return [...seen.values()];
  };
  const convs = firstTo((c) => c.to === "engaged");
  const opps = firstTo((c) => opp.has(c.to ?? "") && !opp.has(c.from ?? ""));
  const closed = firstTo((c) => c.to === "customer");
  const crmRow = (c: StatusChange): FunnelRow => {
    const co = byId.get(c.company_id);
    return {
      company: co?.name ?? c.company_id,
      domain: co?.domain ?? null,
      from: c.from,
      to: c.to,
      date: c.created_at.slice(0, 10),
      tier: co?.tier ?? null,
      trigger: co?.trigger ?? null,
      deployment: co?.deployment ?? null,
      arr: co?.arr ?? null,
      status_now: co?.status ?? null,
    };
  };
  const crmCols = ["company", "domain", "from", "to", "date", "tier", "trigger", "deployment", "arr", "status_now"];
  nodes.conversations = node(
    "conversations",
    "Conversa (lead → engaged)",
    changes ? convs.length : null,
    changes ? `${convs.length}` : "não medido",
    {
      source: "CRM (crm_activities, status_change → engaged)",
      definition: "Contas que entraram em engaged no mês pela primeira vez. Inclui base antiga, rede e outbound.",
      columns: crmCols,
      rows: convs.map(crmRow),
    },
  );
  nodes.opportunities = node(
    "opportunities",
    "Oportunidade",
    changes ? opps.length : null,
    changes ? `${opps.length}` : "não medido",
    {
      source: "CRM (status_change → qualified, poc ou negotiation)",
      definition: "Contas que entraram em qualified, poc ou negotiation no mês vindo de fora desses status.",
      columns: crmCols,
      rows: opps.map(crmRow),
    },
  );
  const closedArr = closed.reduce((s, c) => s + (byId.get(c.company_id)?.arr ?? 0), 0);
  nodes.closed = node(
    "closed",
    "Fechado",
    changes ? closedArr : null,
    changes
      ? `R$ ${Math.round(closedArr).toLocaleString("pt-BR")} · ${closed.length} conta${closed.length === 1 ? "" : "s"}`
      : "não medido",
    {
      target: TARGETS.closed_brl,
      source: "CRM (status_change → customer, campo arr da conta)",
      definition: "Soma do campo arr das contas que viraram customer no mês. Sem arr preenchido, a conta conta zero.",
      columns: crmCols,
      rows: closed.map(crmRow),
    },
  );

  // Open opportunities and idle ones
  const openOpps = crm.filter((c) => opp.has(c.status));
  const idleCut = Date.now() - OPPORTUNITY_IDLE_DAYS * 24 * 60 * 60 * 1000;
  const idle = openOpps.filter((c) => !c.last_activity_at || new Date(c.last_activity_at).getTime() < idleCut);
  rates.push(
    rate(
      "opp_active",
      `abertas agora: ${openOpps.length} · com atividade em ${OPPORTUNITY_IDLE_DAYS} d: ${openOpps.length - idle.length}`,
      companies ? openOpps.length - idle.length : null,
      companies ? openOpps.length : null,
      "nenhuma oportunidade aberta",
    ),
  );
  rates.push(rate("conv_to_opp", changes ? `${pct(opps.length, convs.length)} viram oportunidade` : "viram oportunidade", changes ? opps.length : null, changes ? convs.length : null, "conversa → oportunidade"));

  // ARR: current paying base is not a monthly flow; we show the target only
  // and the sum of arr on customer accounts as the CRM sees it.
  const customerArr = crm.filter((c) => c.status === "customer").reduce((s, c) => s + (c.arr ?? 0), 0);
  nodes.arr = node(
    "arr",
    "ARR",
    customerArr || null,
    customerArr ? `R$ ${Math.round(customerArr).toLocaleString("pt-BR")} (CRM)` : "arr não preenchido no CRM",
    {
      target: TARGETS.arr_brl,
      source: "CRM (soma de arr nas contas customer)",
      definition: "Depende do campo arr estar preenchido em cada conta customer. Stripe e billing não entram aqui.",
      columns: ["company", "domain", "arr", "deployment"],
      rows: crm
        .filter((c) => c.status === "customer")
        .sort((a, b) => (b.arr ?? 0) - (a.arr ?? 0))
        .map((c) => ({ company: c.name, domain: c.domain, arr: c.arr, deployment: c.deployment })),
    },
  );

  // Self-hosted
  nodes.sh_instances = sh ?? node("sh_instances", "Instâncias com uso de empresa", null, "não medido");
  const shCompanies = crm.filter(
    (c) => c.deployment === "self_hosted" && c.created_at >= `${periodStart}` && c.created_at < `${nextStart}T00:00:00Z`,
  );
  const shTrial = shCompanies.filter((c) => c.source === "webhook");
  const shFound = shCompanies.filter((c) => c.source !== "webhook");
  const shRow = (c: CrmCompanyLite): FunnelRow => ({
    company: c.name,
    domain: c.domain,
    source: c.source,
    status: c.status,
    tier: c.tier,
    created: c.created_at.slice(0, 10),
  });
  nodes.sh_trial = node(
    "sh_trial",
    "Pediu trial (mão levantada)",
    companies ? shTrial.length : null,
    companies ? `${shTrial.length}` : "não medido",
    {
      source: "CRM (deployment self_hosted, source webhook = formulário de trial)",
      definition: "Contas self-hosted criadas no mês a partir do formulário de trial (kodus.io/self-hosted-trial).",
      columns: ["company", "domain", "source", "status", "tier", "created"],
      rows: shTrial.map(shRow),
    },
  );
  facts.sh_found = companies
    ? `achadas (PostHog/manual): ${shFound.length} no mês → contatos t3`
    : "";
  nodes.sh_found = node(
    "sh_found",
    "Self-hosted achadas",
    companies ? shFound.length : null,
    companies ? `${shFound.length}` : "não medido",
    {
      source: "CRM (deployment self_hosted, criadas no mês, sem ser pelo formulário)",
      definition: "Instâncias identificadas por PostHog ou à mão e cadastradas no CRM no mês.",
      columns: ["company", "domain", "source", "status", "tier", "created"],
      rows: shFound.map(shRow),
    },
  );

  // Outbound
  if (cold) {
    nodes.ob_contacts = cold.contacts;
    nodes.ob_replies = cold.replies;
    Object.assign(facts, cold.facts);
  } else {
    nodes.ob_contacts = node("ob_contacts", "Contatos novos (cold)", null, "não medido");
    nodes.ob_replies = node("ob_replies", "Respostas de empresa nova", null, "não medido");
  }
  const cc = cold?.counts ?? null;
  rates.push(rate("cold_bounce", cc ? `bounce ${pct(cc.bounced, cc.people)}` : "bounce", cc ? cc.bounced : null, cc ? cc.people : null, "bounce"));
  rates.push(
    rate(
      "cold_reply",
      cc && cc.humanReplies != null ? `resposta humana: ${pct(cc.humanReplies, cc.people)} (${cc.humanReplies} de ${cc.people})` : "resposta humana",
      cc ? cc.humanReplies : null,
      cc ? cc.people : null,
      "resposta humana",
    ),
  );
  // New companies in conversation via outbound = engaged this month with a
  // company that is not linked to a product org (never signed up).
  const newCompanyConvs = convs.filter((c) => !byId.get(c.company_id)?.org_id);
  const newCompanyNode = node(
    "ob_new_conversations",
    "Empresa nova em conversa",
    changes ? newCompanyConvs.length : null,
    changes ? `${newCompanyConvs.length}` : "não medido",
    { target: TARGETS.ob_companies_in_conversation },
  );

  // ---- Bottlenecks: the target stages furthest below what the month needs.
  // Targets are pro-rated for the current month so day 3 does not read as a
  // disaster. Cold with zero replies on a real volume is a bottleneck on its
  // own, because no ratio captures "nobody answers".
  type Candidate = { nodeId: string; ratio: number; lines: string[] };
  const candidates: Candidate[] = [];
  const consider = (
    nodeId: string,
    value: number | null,
    target: number | null,
    fmt: (n: number) => string,
    label: string,
    detail: string[],
  ) => {
    if (value == null || target == null || target <= 0) return;
    // Less than a week in, every target-based ratio is noise.
    if (elapsed < 0.2) return;
    const need = target * elapsed;
    const ratio = value / need;
    if (ratio >= BOTTLENECK_RATIO) return;
    const needText = elapsed < 1 ? `${fmt(Math.round(need))} até aqui (${fmt(target)} no mês)` : fmt(target);
    candidates.push({ nodeId, ratio, lines: [`${label}: ${fmt(value)} de ${needText}`, ...detail.filter(Boolean)] });
  };
  const plain = (n: number) => `${n}`;
  const brl = (n: number) => `R$ ${Math.round(n / 1000)}k`;
  consider("icp", nodes.icp.value, nodes.icp.target, plain, "entra pouca empresa grande", [
    signups ? `${icpProxy.length} de ${corporate.length} cadastros têm ${ICP_MIN_MEMBERS}+ devs` : "",
    facts.non_github ?? "",
  ]);
  consider("connected", signups ? nonGithub.length : null, TARGETS.non_github_signups, plain, "cadastro GitLab/Azure/Bitbucket", [
    facts.platform_split ?? "",
  ]);
  consider("conversations", nodes.conversations.value, nodes.conversations.target, plain, "poucas conversas", [
    rates.find((r) => r.id === "touch_48h")?.label ?? "",
  ]);
  consider("opportunities", nodes.opportunities.value, nodes.opportunities.target, plain, "poucas oportunidades", [
    rates.find((r) => r.id === "conv_to_opp")?.label ?? "",
  ]);
  const closedNoArr = closed.filter((c) => byId.get(c.company_id)?.arr == null).length;
  consider("closed", nodes.closed.value, nodes.closed.target, brl, "fechado abaixo da meta", [
    closedNoArr ? `${closedNoArr} conta${closedNoArr === 1 ? "" : "s"} fechada${closedNoArr === 1 ? "" : "s"} sem arr no CRM` : "",
    rates.find((r) => r.id === "opp_active")?.label ?? "",
  ]);
  consider("ob_replies", newCompanyNode.value, newCompanyNode.target, plain, "pouca empresa nova em conversa", [
    cc ? `cold: ${cc.humanReplies ?? "?"} respostas em ${cc.people} contatos` : "",
  ]);
  if (cc && cc.humanReplies === 0 && cc.people >= COLD_MIN_CONTACTS_FOR_VERDICT) {
    const lo = Math.round(cc.people * RATE_BANDS.cold_reply.lo);
    const hi = Math.round(cc.people * RATE_BANDS.cold_reply.hi);
    candidates.push({
      nodeId: "ob_replies",
      ratio: 0,
      lines: ["cold não responde", `0 de ${cc.people} respondem; mercado 3 a 8% = ${lo} a ${hi}`, "volume existe; mensagem, lista ou canal não"],
    });
  }
  const seen = new Set<string>();
  const bottlenecks: Bottleneck[] = candidates
    .sort((a, b) => a.ratio - b.ratio)
    .filter((c) => (seen.has(c.nodeId) ? false : (seen.add(c.nodeId), true)))
    .slice(0, MAX_BOTTLENECKS)
    .map((c) => ({ nodeId: c.nodeId, lines: c.lines }));

  facts.ob_new_conversations = changes
    ? `empresa nova em conversa: ${newCompanyConvs.length} (sem cadastro no produto) → ${TARGETS.ob_companies_in_conversation}`
    : "";

  return {
    month,
    periodStart,
    periodEnd,
    elapsed,
    generatedAt: new Date().toISOString(),
    nodes,
    facts,
    rates,
    bottlenecks,
    errors,
  };
}
