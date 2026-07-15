import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createContact,
  upsertCompanyFromWebhook,
} from "@/lib/crm";
import { createProspect } from "@/lib/outreach";
import {
  getRow,
  listEvidence,
  listPeople,
  listRows,
} from "@/lib/research/tables";

export async function pushRowToCrm(
  client: SupabaseClient,
  rowId: string,
): Promise<{ companyId: string; contactsCreated: number }> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error("Row not found");

  const evidence = await listEvidence(client, rowId);
  const people = await listPeople(client, rowId);

  const { company } = await upsertCompanyFromWebhook(client, {
    name: row.companyName,
    domain: row.domain,
    website: row.domain ? `https://${row.domain}` : null,
    tags: [
      "research",
      row.pass ? "icp-pass" : "icp-research",
      ...(row.antiFlags ?? []).map((f) => `anti:${f}`),
    ],
    source: "agent",
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
  });

  let contactsCreated = 0;
  const existing = await client
    .from("crm_contacts")
    .select("email, name")
    .eq("company_id", company.id);
  const existingKeys = new Set(
    (existing.data ?? []).map(
      (c) =>
        `${(c.email as string | null)?.toLowerCase() ?? ""}|${(c.name as string).toLowerCase()}`,
    ),
  );

  for (const p of people) {
    const key = `${p.email?.toLowerCase() ?? ""}|${p.name.toLowerCase()}`;
    if (existingKeys.has(key)) continue;
    await createContact(client, company.id, {
      name: p.name,
      email: p.email,
      role: p.role,
      linkedin: p.linkedin,
      isPrimary: contactsCreated === 0,
    });
    contactsCreated += 1;
    existingKeys.add(key);
  }

  return { companyId: company.id, contactsCreated };
}

export async function pushRowToOutreach(
  client: SupabaseClient,
  rowId: string,
  opts: { createdByEmail?: string | null } = {},
): Promise<{ created: number }> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error("Row not found");
  const people = await listPeople(client, rowId);

  let created = 0;
  const targets = people.length > 0
    ? people
    : [
        {
          name: row.companyName,
          email: null as string | null,
          role: null as string | null,
          linkedin: null as string | null,
        },
      ];

  if (!row.domain) {
    throw new Error("Row has no domain — cannot push to outreach");
  }

  for (const p of targets) {
    try {
      await createProspect(client, {
        domain: row.domain,
        url: `https://${row.domain}`,
        contactName: p.name !== row.companyName ? p.name : null,
        contactEmail: p.email,
        contactUrl: p.linkedin,
        status: "prospect",
        priority: row.pass ? "high" : "medium",
        targetType: "partnership",
        niche: row.companyName,
        notes: [
          row.whyNow ? `Why now: ${row.whyNow}` : null,
          row.icpScore != null ? `ICP score: ${row.icpScore}` : null,
          p.role ? `Role: ${p.role}` : null,
          row.antiFlags?.length
            ? `Anti flags: ${row.antiFlags.join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        source: "research",
        createdByEmail: opts.createdByEmail ?? null,
      });
      created += 1;
    } catch (err) {
      console.warn("[research/actions] outreach create failed:", err);
    }
  }

  return { created };
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
    lines.push(
      [
        r.companyName,
        r.domain ?? "",
        r.status,
        r.pass == null ? "" : String(r.pass),
        r.icpScore ?? "",
        r.triggerScore ?? "",
        r.fitScore ?? "",
        (r.antiFlags ?? []).join("|"),
        r.whyNow ?? "",
        people.map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join("; "),
        people.map((p) => p.email).filter(Boolean).join("; "),
        r.source,
        r.lastResearchedAt ?? "",
      ]
        .map((x) => escape(String(x)))
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
