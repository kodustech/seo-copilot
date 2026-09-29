/**
 * Self-hosted trial requests (Tally form GxED1z) into the CRM.
 *
 * Two doors lead here: the signed webhook (app/api/crm/tally) and the replay
 * script (scripts/replay-tally-trials.ts), which reads the Tally API. Each
 * normalizes its own payload into a TrialSubmission and hands it to
 * handleTrialSubmission, so a request lands the same way whichever door saw it
 * — and a second delivery of the same submission changes nothing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createCompany,
  createContact,
  domainFromEmail,
  getCompany,
  listContacts,
  logActivity,
  updateCompany,
  updateContact,
  type CompanyDeployment,
  type CrmCompany,
  type UpdateCompanyInput,
} from "@/lib/crm";
import { classifyDomain } from "@/lib/product-signals/domains";

export const TRIAL_FORM_ID = "GxED1z";

/**
 * Where the instance's own org id lives on the account. It is the org inside
 * the customer's self-hosted install (kodus-ai trial-request.ts), a different
 * namespace from crm_companies.org_id, which the product-signals sweep reads
 * as a Cloud org. Kept in `enrichment` because the account drawer shows that
 * object as it is and PostgREST can filter on it (enrichment->>key); a
 * `properties` key only shows once someone defines the field.
 */
export const SELF_HOSTED_ORG_KEY = "self_hosted_org_id";

// ---------------------------------------------------------------------------
// Normalized shape
// ---------------------------------------------------------------------------

/** One answered field, reduced to text. Choice answers carry the option text,
 *  not Tally's option id. */
export type TallyField = { label: string; hidden: boolean; value: string };

export type TrialSubmission = {
  submissionId: string;
  formId: string;
  /** ISO timestamp of the submission — the date the funnel counts it on. */
  submittedAt: string;
  completed: boolean;
  fields: TallyField[];
};

export type TrialAnswers = {
  name: string | null;
  email: string | null;
  role: string | null;
  company: string | null;
  teamSize: string | null;
  airGapped: string | null;
  notes: string | null;
  orgId: string | null;
  version: string | null;
};

/**
 * Which form field feeds which answer: the one place to fix when the form
 * changes. Questions match by label, ignoring case and punctuation, first
 * exactly and then by containment, so a reworded label around the same words
 * still lands. Hidden fields match by name, and only after every question, so
 * the `email` the product link prefills never beats the work email typed in.
 *
 * Labels are the public form as of 2026-09-29; the first real payload is what
 * confirms them.
 */
const TRIAL_FIELDS: { answer: keyof TrialAnswers; labels?: string[]; hidden?: string }[] = [
  { answer: "name", labels: ["full name", "name"] },
  { answer: "email", labels: ["work email", "email"] },
  { answer: "role", labels: ["role", "job title"] },
  { answer: "company", labels: ["company", "company name"] },
  { answer: "teamSize", labels: ["how many developers will use kodus", "developers", "team size"] },
  { answer: "airGapped", labels: ["is this instance air gapped or without outbound internet access", "air gapped"] },
  { answer: "notes", labels: ["anything we should know", "anything else"] },
  { answer: "orgId", hidden: "org_id" },
  { answer: "version", hidden: "version" },
  { answer: "email", hidden: "email" },
];

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function readTrialAnswers(fields: TallyField[]): TrialAnswers {
  const answers: TrialAnswers = {
    name: null,
    email: null,
    role: null,
    company: null,
    teamSize: null,
    airGapped: null,
    notes: null,
    orgId: null,
    version: null,
  };
  const claimed = new Set<number>();
  const take = (answer: keyof TrialAnswers, hidden: boolean, test: (label: string) => boolean) => {
    if (answers[answer] != null) return;
    const i = fields.findIndex(
      (f, idx) => !claimed.has(idx) && f.hidden === hidden && test(normalizeLabel(f.label)),
    );
    if (i < 0) return;
    claimed.add(i);
    answers[answer] = fields[i].value;
  };

  for (const exact of [true, false]) {
    for (const row of TRIAL_FIELDS) {
      if (!row.labels) continue;
      const labels = row.labels;
      take(row.answer, false, (l) => labels.some((p) => (exact ? l === p : l.includes(p))));
    }
  }
  for (const row of TRIAL_FIELDS) {
    if (!row.hidden) continue;
    const name = normalizeLabel(row.hidden);
    take(row.answer, true, (l) => l === name);
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** First value that parses as a date, as canonical UTC ISO; now otherwise.
 *  The timestamp ends up inside a PostgREST filter (logActivity's touch), so
 *  it must never reach there in whatever form the payload spelled it. */
function isoOrNow(...values: unknown[]): string {
  for (const v of values) {
    const s = str(v);
    if (!s) continue;
    const t = new Date(s).getTime();
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/** An answer as text. Choice questions answer with option ids; `options` maps
 *  them back to what the respondent actually picked. */
function answerText(value: unknown, options: Map<string, string>): string | null {
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => (typeof v === "string" ? (options.get(v) ?? v) : typeof v === "number" ? String(v) : null))
      .filter((v): v is string => Boolean(v && v.trim()));
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "string") {
    const t = value.trim();
    return t ? (options.get(t) ?? t) : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Tally-Signature is a base64 HMAC-SHA256 of the payload with the webhook's
 * signing secret. Tally's own example signs JSON.stringify of the parsed body,
 * which is byte-for-byte the raw body whenever Tally sends compact JSON; both
 * are checked so a difference in serialization can't drop real submissions.
 * Either way the secret is what proves the sender.
 */
export function verifyTallySignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const bodies = [rawBody];
  try {
    const reserialized = JSON.stringify(JSON.parse(rawBody));
    if (reserialized !== rawBody) bodies.push(reserialized);
  } catch {
    // Not JSON: the raw body is all there is to check.
  }
  const given = Buffer.from(signature.trim());
  return bodies.some((body) => {
    const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64"));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** The webhook's FORM_RESPONSE event. Null when it isn't one. */
export function fromTallyWebhook(payload: unknown): TrialSubmission | null {
  const event = asRecord(payload);
  const data = asRecord(event?.data);
  if (!event || !data) return null;
  // submissionId only: it is the id the API lists the same submission under,
  // which is what lets the webhook and the replay dedupe against each other.
  const submissionId = str(data.submissionId);
  const formId = str(data.formId);
  if (!submissionId || !formId) return null;

  const fields: TallyField[] = [];
  for (const raw of Array.isArray(data.fields) ? data.fields : []) {
    const f = asRecord(raw);
    const label = str(f?.label);
    if (!f || !label) continue;
    const options = new Map<string, string>();
    for (const o of Array.isArray(f.options) ? f.options : []) {
      const opt = asRecord(o);
      const id = str(opt?.id);
      const text = str(opt?.text);
      if (id && text) options.set(id, text);
    }
    const value = answerText(f.value, options);
    if (value != null) fields.push({ label, hidden: f.type === "HIDDEN_FIELDS", value });
  }

  return {
    submissionId,
    formId,
    submittedAt: isoOrNow(data.createdAt, event.createdAt),
    // Tally posts FORM_RESPONSE when a respondent finishes the form. Anything
    // else, or a payload that says outright it isn't complete, is a partial.
    completed: event.eventType === "FORM_RESPONSE" && data.isCompleted !== false,
    fields,
  };
}

/**
 * One submission from GET /forms/{id}/submissions. The API answers by
 * question id, so labels come from the `questions` list of the same response.
 * The API docs don't show how hidden fields or choices are answered, so both
 * readings are handled: a hidden-fields block answered as an object of
 * name (or field uuid) → value, and choice answers given as option ids or as
 * option text. The replay's dry run prints what came out before anything is
 * written.
 */
export function fromTallyApi(submission: unknown, questions: unknown): TrialSubmission | null {
  const s = asRecord(submission);
  const submissionId = str(s?.id);
  const formId = str(s?.formId);
  if (!s || !submissionId || !formId) return null;

  const byId = new Map<string, Record<string, unknown>>();
  // uuid → title of every sub-field: hidden field names, and the options of a
  // choice question.
  const titles = new Map<string, string>();
  for (const raw of Array.isArray(questions) ? questions : []) {
    const q = asRecord(raw);
    const id = str(q?.id);
    if (!q || !id) continue;
    byId.set(id, q);
    for (const f of Array.isArray(q.fields) ? q.fields : []) {
      const field = asRecord(f);
      const uuid = str(field?.uuid);
      const title = str(field?.title);
      if (uuid && title) titles.set(uuid, title);
    }
  }

  const fields: TallyField[] = [];
  for (const raw of Array.isArray(s.responses) ? s.responses : []) {
    const r = asRecord(raw);
    const questionId = str(r?.questionId);
    if (!r || !questionId) continue;
    const q = byId.get(questionId);
    const hidden = q?.type === "HIDDEN_FIELDS";
    const byName = hidden ? asRecord(r.answer) : null;
    if (byName) {
      for (const [key, v] of Object.entries(byName)) {
        const value = answerText(v, titles);
        if (value != null) fields.push({ label: titles.get(key) ?? key, hidden: true, value });
      }
      continue;
    }
    const subFields = Array.isArray(q?.fields) ? q.fields : [];
    const label =
      (hidden && subFields.length === 1 ? str(asRecord(subFields[0])?.title) : null) ??
      str(q?.title) ??
      titles.get(questionId) ??
      questionId;
    const value = answerText(r.answer, titles);
    if (value != null) fields.push({ label, hidden, value });
  }

  return {
    submissionId,
    formId,
    submittedAt: isoOrNow(s.submittedAt, s.createdAt),
    completed: s.isCompleted !== false,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export type MatchBy = "self_hosted_org_id" | "domain" | "contact_email";

/** The email's domain when it names a company. Free mail, academic and our
 *  own domains name nobody, so they never match or create by domain. */
export function corporateDomain(email: string | null): string | null {
  const domain = domainFromEmail(email);
  return domain && classifyDomain(domain) === "corporate" ? domain : null;
}

/** Company, else the person, else the email's local part. A personal-email
 *  request with no company still becomes an account (decided on #263). */
export function trialAccountName(a: TrialAnswers): string {
  return a.company ?? a.name ?? (a.email?.split("@")[0] || null) ?? "Self-hosted trial request";
}

/** The timeline shows `summary` and not `meta`, so the answers go here too. */
export function trialSummary(a: TrialAnswers): string {
  const who = [a.name, a.role && `(${a.role})`, a.company && `at ${a.company}`]
    .filter(Boolean)
    .join(" ");
  return [
    `Asked for a self-hosted trial${who ? `: ${who}` : ""}`,
    a.email,
    a.teamSize && `devs: ${a.teamSize}`,
    a.airGapped && `air-gapped: ${a.airGapped}`,
    a.version && `version ${a.version}`,
    a.orgId && `instance org ${a.orgId}`,
    a.notes && `"${a.notes}"`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function firstId(
  query: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  column: string,
): Promise<string | null> {
  const { data, error } = await query;
  if (error) throw new Error(`Failed to match trial request: ${error.message}`);
  const row = asRecord((data ?? [])[0]);
  return str(row?.[column]);
}

/**
 * The account this request belongs to, most specific first: the instance
 * already on an account, then the company domain, then a person we already
 * know. Excluded accounts are matched too — creating a second row next to one
 * a human excluded is the duplicate this order exists to prevent.
 */
export async function matchTrialAccount(
  client: SupabaseClient,
  a: { orgId: string | null; domain: string | null; email: string | null },
): Promise<{ company: CrmCompany; by: MatchBy } | null> {
  const found = async (id: string | null, by: MatchBy) => {
    const company = id ? await getCompany(client, id) : null;
    return company ? { company, by } : null;
  };

  if (a.orgId) {
    const id = await firstId(
      client
        .from("crm_companies")
        .select("id")
        .eq(`enrichment->>${SELF_HOSTED_ORG_KEY}`, a.orgId)
        .order("created_at", { ascending: true })
        .limit(1),
      "id",
    );
    const hit = await found(id, "self_hosted_org_id");
    if (hit) return hit;
  }
  if (a.domain) {
    const id = await firstIgnoringCase(client, "crm_companies", "domain", a.domain, "id");
    const hit = await found(id, "domain");
    if (hit) return hit;
  }
  if (a.email) {
    const id = await firstIgnoringCase(client, "crm_contacts", "email", a.email, "company_id");
    const hit = await found(id, "contact_email");
    if (hit) return hit;
  }
  return null;
}

/**
 * `idColumn` of the oldest row whose `column` equals `value`, ignoring case.
 * Stored domains and emails keep whatever case they arrived in, hence ilike;
 * the exact comparison after it keeps a wildcard in the value from matching
 * wide.
 */
async function firstIgnoringCase(
  client: SupabaseClient,
  table: string,
  column: string,
  value: string,
  idColumn: string,
): Promise<string | null> {
  const want = value.trim().toLowerCase();
  if (!want) return null;
  const { data, error } = await client
    .from(table)
    .select(`${idColumn},${column}`)
    .ilike(column, escapeLike(want))
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`Failed to match trial request: ${error.message}`);
  const row = (data ?? [])
    .map((r) => asRecord(r))
    .find((r) => String(r?.[column] ?? "").trim().toLowerCase() === want);
  return str(row?.[idColumn]);
}

/** Merge the requester into the account's people. Never overwrites: an
 *  existing person only gains a role nobody had filled in. Archived people
 *  count as existing — a human removed them, and a form is not a reason to
 *  put them back. */
async function upsertRequester(
  client: SupabaseClient,
  companyId: string,
  a: TrialAnswers,
): Promise<"created" | "updated" | "existing" | "none"> {
  const email = a.email?.trim().toLowerCase() || null;
  const name = a.name ?? (email?.split("@")[0] || null);
  if (!name) return "none";

  const people = await listContacts(client, companyId, { includeArchived: true });
  const same = people.find((c) =>
    email
      ? c.email?.trim().toLowerCase() === email
      : c.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (same) {
    if (a.role && !same.role) {
      await updateContact(client, same.id, { role: a.role });
      return "updated";
    }
    return "existing";
  }
  await createContact(client, companyId, {
    name,
    email: a.email,
    role: a.role,
    isPrimary: people.every((c) => c.archivedAt),
  });
  return "created";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type TrialOutcome = {
  submissionId: string;
  action: "skipped" | "matched" | "created";
  reason?: "other_form" | "partial" | "already_recorded";
  /** False on a dry run: the outcome is what would happen. */
  applied: boolean;
  companyId: string | null;
  companyName: string | null;
  matchedBy: MatchBy | null;
  /** Set when a matched account's deployment was changed to self_hosted. */
  previousDeployment?: CompanyDeployment | null;
  contact?: "created" | "updated" | "existing" | "none";
  answers?: TrialAnswers;
};

async function recordedCompany(client: SupabaseClient, submissionId: string): Promise<string | null> {
  return firstId(
    client
      .from("crm_activities")
      .select("company_id")
      .eq("kind", "trial_request")
      .eq("meta->>submission_id", submissionId)
      .limit(1),
    "company_id",
  );
}

export async function handleTrialSubmission(
  client: SupabaseClient,
  submission: TrialSubmission,
  opts: { apply: boolean },
): Promise<TrialOutcome> {
  const base = {
    submissionId: submission.submissionId,
    applied: opts.apply,
    companyId: null,
    companyName: null,
    matchedBy: null,
  };
  if (submission.formId !== TRIAL_FORM_ID) return { ...base, action: "skipped", reason: "other_form" };
  if (!submission.completed) return { ...base, action: "skipped", reason: "partial" };

  // The activity row is the record that this submission was handled. Tally
  // retries a delivery it thinks failed, and the replay walks submissions the
  // webhook may already have seen.
  const recorded = await recordedCompany(client, submission.submissionId);
  if (recorded) return { ...base, action: "skipped", reason: "already_recorded", companyId: recorded };

  const answers = readTrialAnswers(submission.fields);
  const domain = corporateDomain(answers.email);
  const match = await matchTrialAccount(client, { orgId: answers.orgId, domain, email: answers.email });

  if (!opts.apply) {
    return {
      ...base,
      action: match ? "matched" : "created",
      companyId: match?.company.id ?? null,
      companyName: match?.company.name ?? trialAccountName(answers),
      matchedBy: match?.by ?? null,
      ...(match && match.company.deployment !== "self_hosted"
        ? { previousDeployment: match.company.deployment }
        : {}),
      answers,
    };
  }

  let company: CrmCompany;
  let previousDeployment: CompanyDeployment | null | undefined;
  if (match) {
    company = match.company;
    // The name stays: it is either a human's or the sweep's, and both know
    // the company better than a free-text form field does.
    const patch: UpdateCompanyInput = {};
    // Flipped even from cloud, so the request shows under the self_hosted
    // filter the team works from. The previous value goes in the activity.
    if (company.deployment !== "self_hosted") {
      patch.deployment = "self_hosted";
      previousDeployment = company.deployment;
    }
    // First instance wins: overwriting would stop the earlier instance from
    // matching. A later one's org id is still in its own activity.
    if (answers.orgId && !str(company.enrichment[SELF_HOSTED_ORG_KEY])) {
      patch.enrichment = { ...company.enrichment, [SELF_HOSTED_ORG_KEY]: answers.orgId };
    }
    if (Object.keys(patch).length > 0) company = await updateCompany(client, company.id, patch);
  } else {
    company = await createCompany(client, {
      name: trialAccountName(answers),
      domain,
      deployment: "self_hosted",
      source: "webhook",
      enrichment: answers.orgId ? { [SELF_HOSTED_ORG_KEY]: answers.orgId } : {},
    });
  }

  const contact = await upsertRequester(client, company.id, answers);

  await logActivity(client, company.id, "trial_request", {
    summary: trialSummary(answers),
    createdAt: submission.submittedAt,
    meta: {
      submission_id: submission.submissionId,
      form_id: submission.formId,
      submitted_at: submission.submittedAt,
      matched_by: match?.by ?? null,
      answers: {
        name: answers.name,
        email: answers.email,
        role: answers.role,
        company: answers.company,
        team_size: answers.teamSize,
        air_gapped: answers.airGapped,
        notes: answers.notes,
        org_id: answers.orgId,
        version: answers.version,
      },
      // Every answered field as the form labelled it, so a question the table
      // above doesn't map yet is kept instead of dropped.
      fields: submission.fields,
      ...(previousDeployment !== undefined ? { previous_deployment: previousDeployment } : {}),
    },
  });

  return {
    ...base,
    action: match ? "matched" : "created",
    companyId: company.id,
    companyName: company.name,
    matchedBy: match?.by ?? null,
    ...(previousDeployment !== undefined ? { previousDeployment } : {}),
    contact,
    answers,
  };
}
