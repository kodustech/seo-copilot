import type { SupabaseClient } from "@supabase/supabase-js";

import { upsertAccountByDomain } from "@/lib/crm";
import {
  getRow,
  listEvidence,
  listPeople,
  listRows,
} from "@/lib/research/tables";

/**
 * Push a research row into Accounts (CRM) — Convert system of record.
 * Company by domain + contacts from research_people.
 */
export async function pushRowToCrm(
  client: SupabaseClient,
  rowId: string,
): Promise<{ companyId: string; contactsCreated: number }> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error("Row not found");

  const evidence = await listEvidence(client, rowId);
  const people = await listPeople(client, rowId);

  let contactsCreated = 0;
  let companyId: string | null = null;

  // Create/update company once
  const first = people[0];
  const base = await upsertAccountByDomain(client, {
    name: row.companyName,
    domain: row.domain,
    website: row.domain ? `https://${row.domain}` : null,
    status: row.pass ? "qualified" : "lead",
    priority: row.pass ? "high" : "medium",
    tags: [
      "research",
      row.pass ? "icp-pass" : "icp-research",
      ...(row.antiFlags ?? []).map((f) => `anti:${f}`),
    ],
    source: "research",
    notes: row.whyNow ? `Why now: ${row.whyNow}` : null,
    enrichment: {
      research: {
        icp_score: row.icpScore,
        trigger_score: row.triggerScore,
        fit_score: row.fitScore,
        pass: row.pass,
        why_now: row.whyNow,
        anti_flags: row.antiFlags,
        criteria: evidence.map((e) => ({
          id: e.criterionId,
          kind: e.kind,
          status: e.status,
          evidence: e.evidence,
        })),
        researched_at: row.lastResearchedAt,
      },
    },
    contact: first
      ? {
          name: first.name,
          email: first.email,
          role: first.role,
          linkedin: first.linkedin,
        }
      : null,
  });
  companyId = base.company.id;
  if (base.contactCreated) contactsCreated += 1;

  // Remaining people as contacts
  for (const p of people.slice(1)) {
    const more = await upsertAccountByDomain(client, {
      name: row.companyName,
      domain: row.domain,
      source: "research",
      contact: {
        name: p.name,
        email: p.email,
        role: p.role,
        linkedin: p.linkedin,
      },
    });
    if (more.contactCreated) contactsCreated += 1;
  }

  return { companyId: companyId!, contactsCreated };
}

/**
 * @deprecated Pipeline board removed — Convert is Accounts (CRM).
 * Kept for API compatibility; same as pushRowToCrm.
 */
export async function pushRowToOutreach(
  client: SupabaseClient,
  rowId: string,
  _opts: { createdByEmail?: string | null } = {},
): Promise<{ created: number; companyId: string }> {
  const result = await pushRowToCrm(client, rowId);
  return {
    created: Math.max(result.contactsCreated, 1),
    companyId: result.companyId,
  };
}

export function rowsToCsv(
  rows: Awaited<ReturnType<typeof listRows>>,
  peopleByRow: Map<string, Awaited<ReturnType<typeof listPeople>>>,
): string {
  const headers = [
    "company_name",
    "domain",
    "status",
    "pass",
    "icp_score",
    "trigger_score",
    "fit_score",
    "anti_flags",
    "why_now",
    "people",
    "emails",
    "source",
    "last_researched_at",
  ];

  const escape = (v: string) => {
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };

  const lines = [headers.join(",")];
  for (const r of rows) {
    const people = peopleByRow.get(r.id) ?? [];
    const peopleNames = people.map((p) => p.name).join("; ");
    const emails = people
      .map((p) => p.email)
      .filter(Boolean)
      .join("; ");
    lines.push(
      [
        r.companyName,
        r.domain ?? "",
        r.status,
        r.pass == null ? "" : r.pass ? "pass" : "fail",
        r.icpScore ?? "",
        r.triggerScore ?? "",
        r.fitScore ?? "",
        (r.antiFlags ?? []).join("|"),
        r.whyNow ?? "",
        peopleNames,
        emails,
        r.source ?? "",
        r.lastResearchedAt ?? "",
      ]
        .map((v) => escape(String(v)))
        .join(","),
    );
  }
  return lines.join("\n");
}

export async function exportTableCsv(
  client: SupabaseClient,
  tableId: string,
  opts: { passOnly?: boolean; minScore?: number } = {},
): Promise<string> {
  const rows = await listRows(client, tableId, opts);
  const peopleByRow = new Map<
    string,
    Awaited<ReturnType<typeof listPeople>>
  >();
  for (const r of rows) {
    peopleByRow.set(r.id, await listPeople(client, r.id));
  }
  return rowsToCsv(rows, peopleByRow);
}
