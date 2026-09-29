import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  corporateDomain,
  fromTallyApi,
  fromTallyWebhook,
  handleTrialSubmission,
  readTrialAnswers,
  trialAccountName,
  verifyTallySignature,
  type TrialAnswers,
  type TrialSubmission,
} from "@/lib/crm-trial-requests";

/**
 * Self-hosted trial requests arrive from Tally form GxED1z, through the signed
 * webhook or through the replay of the Tally API. These pin what the design on
 * #263 decided: which account a request lands on, that the instance's org id
 * never goes into crm_companies.org_id (the sweep reads that as a Cloud org),
 * that nothing is wiped, and that the same submission twice is one request.
 */

type Row = Record<string, unknown>;

/**
 * An in-memory stand-in for the handful of PostgREST calls the handler makes:
 * select/eq (including `col->>key` on jsonb), ilike, is, order, limit, insert
 * and update. Every write is logged so a test can say what was touched.
 */
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    crm_companies: [],
    crm_contacts: [],
    crm_activities: [],
    ...seed,
  };
  const writes: { op: "insert" | "update"; table: string; row: Row }[] = [];
  let seq = 0;

  const read = (row: Row, col: string): unknown => {
    const json = col.match(/^(\w+)->>(\w+)$/);
    if (json) {
      const v = (row[json[1]] as Row | null | undefined)?.[json[2]];
      return v == null ? null : String(v);
    }
    return row[col] ?? null;
  };

  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let inserted: Row | null = null;
    let limit: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    const rows = () => (tables[table] ??= []);

    const run = () => {
      if (inserted) return { data: [{ ...inserted }], error: null };
      let hit = rows().filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of hit) Object.assign(r, patch);
      if (order) {
        const { col, asc } = order;
        hit = [...hit].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1));
      }
      if (limit != null) hit = hit.slice(0, limit);
      return { data: hit.map((r) => ({ ...r })), error: null };
    };

    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => read(r, col) === v), b),
      is: (col: string, v: unknown) => (filters.push((r) => read(r, col) === v), b),
      ilike: (col: string, pattern: string) => {
        const want = pattern.replace(/\\(.)/g, "$1").toLowerCase();
        filters.push((r) => String(read(r, col) ?? "").toLowerCase() === want);
        return b;
      },
      // Only the shapes the code sends: `col.is.null` and `col.lt.<iso>`.
      or: (expr: string) => {
        const clauses = expr.split(",").map((c) => c.match(/^(\w+)\.(is|lt)\.(.+)$/)!);
        filters.push((r) =>
          clauses.some(([, col, op, v]) => {
            const cur = read(r, col);
            return op === "is" ? cur === null : cur != null && String(cur) < v;
          }),
        );
        return b;
      },
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limit = n), b),
      insert: (row: Row) => {
        const now = new Date().toISOString();
        inserted = { id: `${table}-${++seq}`, created_at: now, updated_at: now, ...row };
        rows().push(inserted);
        writes.push({ op: "insert", table, row: { ...row } });
        return b;
      },
      update: (p: Row) => {
        patch = p;
        writes.push({ op: "update", table, row: { ...p } });
        return b;
      },
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      single: async () => {
        const row = run().data[0];
        return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  }

  return { client: { from } as never, tables, writes };
}

function company(overrides: Row): Row {
  return {
    name: "Acme",
    domain: null,
    org_id: null,
    status: "lead",
    priority: "medium",
    tags: [],
    enrichment: {},
    properties: {},
    deployment: null,
    source: "manual",
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// The form as it is published (tally.so/r/GxED1z): two dropdowns answer with
// option ids, and the hidden fields are org_id and version.
const TEAM = [
  { id: "opt-only-me", text: "Only me" },
  { id: "opt-11-25", text: "11-25" },
];
const AIR = [
  { id: "opt-no", text: "No" },
  { id: "opt-yes", text: "Yes" },
];

function webhookPayload(over: { email?: string; orgId?: string | null; company?: string; formId?: string; eventType?: string; submissionId?: string } = {}) {
  const fields: Row[] = [
    { key: "q_h_1", label: "org_id", type: "HIDDEN_FIELDS", value: over.orgId === undefined ? "inst-org-1" : over.orgId },
    { key: "q_h_2", label: "version", type: "HIDDEN_FIELDS", value: "1.8.0" },
    { key: "q1", label: "Full name", type: "INPUT_TEXT", value: "Jane Roe" },
    { key: "q2", label: "Work email", type: "INPUT_EMAIL", value: over.email ?? "jane@acme.com" },
    { key: "q3", label: "Role", type: "INPUT_TEXT", value: "Head of Platform" },
    { key: "q4", label: "Company", type: "INPUT_TEXT", value: over.company ?? "Acme Corp" },
    { key: "q5", label: "How many developers will use Kodus?", type: "DROPDOWN", value: ["opt-11-25"], options: TEAM },
    { key: "q6", label: "Is this instance air-gapped or without outbound internet access?", type: "DROPDOWN", value: ["opt-yes"], options: AIR },
    { key: "q7", label: "Anything we should know?", type: "TEXTAREA", value: "Evaluating against CodeRabbit" },
  ];
  return {
    eventId: "evt-1",
    eventType: over.eventType ?? "FORM_RESPONSE",
    createdAt: "2026-09-18T14:02:11.889Z",
    data: {
      responseId: over.submissionId ?? "sub-1",
      submissionId: over.submissionId ?? "sub-1",
      respondentId: "resp-1",
      formId: over.formId ?? "GxED1z",
      formName: "Request a Kodus self-hosted trial",
      createdAt: "2026-09-18T14:02:11.000Z",
      fields: fields.filter((f) => f.value != null),
    },
  };
}

function submission(over: Parameters<typeof webhookPayload>[0] = {}): TrialSubmission {
  const s = fromTallyWebhook(webhookPayload(over));
  if (!s) throw new Error("fixture did not parse");
  return s;
}

const JANE: TrialAnswers = {
  name: "Jane Roe",
  email: "jane@acme.com",
  role: "Head of Platform",
  company: "Acme Corp",
  teamSize: "11-25",
  airGapped: "Yes",
  notes: "Evaluating against CodeRabbit",
  orgId: "inst-org-1",
  version: "1.8.0",
};

describe("Tally signature", () => {
  const secret = "whsec-test";
  const sign = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("base64");
  const body = JSON.stringify(webhookPayload());

  it("accepts the HMAC-SHA256 of the body in base64", () => {
    expect(verifyTallySignature(body, sign(body), secret)).toBe(true);
  });

  it("accepts Tally's documented form, JSON.stringify of the parsed payload", () => {
    const pretty = JSON.stringify(webhookPayload(), null, 2);
    expect(verifyTallySignature(pretty, sign(JSON.stringify(JSON.parse(pretty))), secret)).toBe(true);
  });

  it("rejects a signature made with another secret, a tampered body, or none", () => {
    expect(verifyTallySignature(body, sign(body, "other"), secret)).toBe(false);
    expect(verifyTallySignature(body.replace("Jane", "Mallory"), sign(body), secret)).toBe(false);
    expect(verifyTallySignature(body, null, secret)).toBe(false);
  });

  it("rejects everything when the secret is unset", () => {
    expect(verifyTallySignature(body, sign(body, ""), undefined)).toBe(false);
    expect(verifyTallySignature(body, sign(body, ""), "")).toBe(false);
  });
});

describe("normalizing a submission", () => {
  it("reads every answer from the webhook, with dropdown ids turned into what was picked", () => {
    const s = submission();
    expect(s).toMatchObject({
      submissionId: "sub-1",
      formId: "GxED1z",
      submittedAt: "2026-09-18T14:02:11.000Z",
      completed: true,
    });
    expect(readTrialAnswers(s.fields)).toEqual(JANE);
  });

  it("reads the same answers from the Tally API shape", () => {
    const questions = [
      { id: "QH", type: "HIDDEN_FIELDS", title: "", fields: [{ uuid: "u-org", title: "org_id" }, { uuid: "u-ver", title: "version" }] },
      { id: "Q1", type: "INPUT_TEXT", title: "Full name", fields: [] },
      { id: "Q2", type: "INPUT_EMAIL", title: "Work email", fields: [] },
      { id: "Q3", type: "INPUT_TEXT", title: "Role", fields: [] },
      { id: "Q4", type: "INPUT_TEXT", title: "Company", fields: [] },
      { id: "Q5", type: "DROPDOWN", title: "How many developers will use Kodus?", fields: TEAM.map((o) => ({ uuid: o.id, title: o.text })) },
      { id: "Q6", type: "DROPDOWN", title: "Is this instance air-gapped or without outbound internet access?", fields: AIR.map((o) => ({ uuid: o.id, title: o.text })) },
      { id: "Q7", type: "TEXTAREA", title: "Anything we should know?", fields: [] },
    ];
    const apiSubmission = {
      id: "sub-1",
      formId: "GxED1z",
      isCompleted: true,
      submittedAt: "2026-09-18T14:02:11.000Z",
      responses: [
        { questionId: "QH", answer: { org_id: "inst-org-1", "u-ver": "1.8.0" } },
        { questionId: "Q1", answer: "Jane Roe" },
        { questionId: "Q2", answer: "jane@acme.com" },
        { questionId: "Q3", answer: "Head of Platform" },
        { questionId: "Q4", answer: "Acme Corp" },
        // One dropdown answered by option id, the other by text: the docs
        // don't say which the API returns, and both have to read the same.
        { questionId: "Q5", answer: ["opt-11-25"] },
        { questionId: "Q6", answer: ["Yes"] },
        { questionId: "Q7", answer: "Evaluating against CodeRabbit" },
      ],
    };
    const s = fromTallyApi(apiSubmission, questions);
    expect(s).toMatchObject({ submissionId: "sub-1", formId: "GxED1z", submittedAt: "2026-09-18T14:02:11.000Z", completed: true });
    expect(readTrialAnswers(s!.fields)).toEqual(JANE);
  });

  it("refuses a delivery without submissionId rather than keying it on another id", () => {
    const payload = webhookPayload();
    delete (payload.data as Partial<typeof payload.data>).submissionId;
    expect(payload.data.responseId).toBe("sub-1");
    expect(fromTallyWebhook(payload)).toBeNull();
  });

  it("marks anything but a FORM_RESPONSE, and an API partial, as not completed", () => {
    expect(submission({ eventType: "FORM_PARTIAL_RESPONSE" }).completed).toBe(false);
    expect(fromTallyApi({ id: "s", formId: "GxED1z", isCompleted: false, responses: [] }, [])?.completed).toBe(false);
  });

  it("prefers the typed work email over the email the product link prefills", () => {
    const answers = readTrialAnswers([
      { label: "email", hidden: true, value: "admin@selfhosted.local" },
      { label: "Your work email", hidden: false, value: "jane@acme.com" },
    ]);
    expect(answers.email).toBe("jane@acme.com");
    expect(readTrialAnswers([{ label: "email", hidden: true, value: "jane@acme.com" }]).email).toBe("jane@acme.com");
  });

  it("tolerates reworded labels without letting one question claim another's answer", () => {
    const answers = readTrialAnswers([
      { label: "Company", hidden: false, value: "Acme" },
      { label: "Your role at the company", hidden: false, value: "CTO" },
      { label: "Name", hidden: false, value: "Jane" },
    ]);
    expect(answers).toMatchObject({ company: "Acme", role: "CTO", name: "Jane" });
  });
});

describe("naming a new account", () => {
  const blank = { ...JANE, company: null, name: null, email: null };
  it("uses the company, else the person, else the email's local part", () => {
    expect(trialAccountName(JANE)).toBe("Acme Corp");
    expect(trialAccountName({ ...JANE, company: null })).toBe("Jane Roe");
    expect(trialAccountName({ ...blank, email: "jroe@gmail.com" })).toBe("jroe");
    expect(trialAccountName(blank)).toBe("Self-hosted trial request");
  });

  it("gives free mail, academic and our own domains no company domain", () => {
    expect(corporateDomain("jane@acme.com")).toBe("acme.com");
    expect(corporateDomain("jane@gmail.com")).toBeNull();
    expect(corporateDomain("jane@usp.br")).toBeNull();
    expect(corporateDomain("dev@kodus.io")).toBeNull();
  });
});

describe("handling a trial request", () => {
  it("ignores other forms and partial submissions without touching the CRM", async () => {
    const client = { from: () => { throw new Error("touched the CRM"); } } as never;
    await expect(handleTrialSubmission(client, submission({ formId: "npjK2P" }), { apply: true }))
      .resolves.toMatchObject({ action: "skipped", reason: "other_form" });
    await expect(handleTrialSubmission(client, submission({ eventType: "FORM_PARTIAL_RESPONSE" }), { apply: true }))
      .resolves.toMatchObject({ action: "skipped", reason: "partial" });
  });

  describe("match order", () => {
    const seed = () => ({
      crm_companies: [
        company({ id: "by-org", name: "Instance Owner", enrichment: { self_hosted_org_id: "inst-org-1" } }),
        company({ id: "by-domain", name: "Acme", domain: "acme.com", created_at: "2026-02-01T00:00:00Z" }),
        company({ id: "by-contact", name: "Jane's Co", created_at: "2026-03-01T00:00:00Z" }),
        // A free-mail "company" must never catch a gmail request.
        company({ id: "gmail-row", name: "gmail.com", domain: "gmail.com" }),
      ],
      crm_contacts: [
        { id: "p1", company_id: "by-contact", name: "Jane", email: "Jane@Acme.com", role: null, is_primary: true, created_at: "2026-03-01T00:00:00Z" },
        { id: "p2", company_id: "by-contact", name: "Sam", email: "sam@gmail.com", role: null, is_primary: false, created_at: "2026-03-01T00:00:00Z" },
      ],
    });

    it("takes the account that already holds the instance's org id first", async () => {
      const db = fakeDb(seed());
      const o = await handleTrialSubmission(db.client, submission(), { apply: false });
      expect(o).toMatchObject({ action: "matched", companyId: "by-org", matchedBy: "self_hosted_org_id" });
    });

    it("then the corporate domain of the work email", async () => {
      const db = fakeDb(seed());
      const o = await handleTrialSubmission(db.client, submission({ orgId: null }), { apply: false });
      expect(o).toMatchObject({ action: "matched", companyId: "by-domain", matchedBy: "domain" });
    });

    it("matches a stored domain whatever its case", async () => {
      const db = fakeDb({ crm_companies: [company({ id: "mixed-case", domain: "Acme.COM" })] });
      const o = await handleTrialSubmission(db.client, submission({ orgId: null }), { apply: false });
      expect(o).toMatchObject({ action: "matched", companyId: "mixed-case", matchedBy: "domain" });
    });

    it("then a contact with that email, never a free-mail domain", async () => {
      const db = fakeDb(seed());
      const o = await handleTrialSubmission(db.client, submission({ orgId: null, email: "SAM@gmail.com" }), { apply: false });
      expect(o).toMatchObject({ action: "matched", companyId: "by-contact", matchedBy: "contact_email" });
    });

    it("writes nothing on a dry run", async () => {
      const db = fakeDb(seed());
      await handleTrialSubmission(db.client, submission({ orgId: "new-inst", email: "x@new.io" }), { apply: false });
      expect(db.writes).toEqual([]);
    });
  });

  it("flips a matched Cloud account to self_hosted, keeps its name and leaves org_id alone", async () => {
    const db = fakeDb({
      crm_companies: [company({ id: "acme", name: "Acme (renamed by hand)", domain: "acme.com", org_id: "cloud-org-9", deployment: "cloud", enrichment: { icp_gate: "pass" } })],
    });
    const o = await handleTrialSubmission(db.client, submission(), { apply: true });

    expect(o).toMatchObject({ action: "matched", matchedBy: "domain", previousDeployment: "cloud", contact: "created" });
    const row = db.tables.crm_companies[0];
    expect(row).toMatchObject({
      name: "Acme (renamed by hand)",
      org_id: "cloud-org-9",
      deployment: "self_hosted",
      enrichment: { icp_gate: "pass", self_hosted_org_id: "inst-org-1" },
    });
    const companyUpdates = db.writes.filter((w) => w.table === "crm_companies" && w.op === "update");
    for (const w of companyUpdates) {
      expect(w.row).not.toHaveProperty("org_id");
      expect(w.row).not.toHaveProperty("name");
    }

    const [activity] = db.tables.crm_activities.filter((a) => a.kind === "trial_request");
    expect(activity.meta).toMatchObject({
      submission_id: "sub-1",
      form_id: "GxED1z",
      previous_deployment: "cloud",
      answers: { team_size: "11-25", air_gapped: "Yes", org_id: "inst-org-1", version: "1.8.0", role: "Head of Platform" },
    });
  });

  it("creates a self-hosted account from a personal email, without a domain or an org_id", async () => {
    const db = fakeDb();
    const o = await handleTrialSubmission(db.client, submission({ email: "jroe@gmail.com", company: "" }), { apply: true });

    expect(o).toMatchObject({ action: "created", companyName: "Jane Roe", contact: "created" });
    const [row] = db.tables.crm_companies;
    expect(row).toMatchObject({
      name: "Jane Roe",
      domain: null,
      org_id: null,
      deployment: "self_hosted",
      source: "webhook",
      enrichment: { self_hosted_org_id: "inst-org-1" },
    });
    expect(db.tables.crm_contacts).toEqual([
      expect.objectContaining({ company_id: row.id, name: "Jane Roe", email: "jroe@gmail.com", role: "Head of Platform", is_primary: true }),
    ]);

    const activity = db.tables.crm_activities.find((a) => a.kind === "trial_request")!;
    // Dated by the submission, so a replay lands in the month it was asked.
    expect(activity.created_at).toBe("2026-09-18T14:02:11.000Z");
    expect(activity.meta).not.toHaveProperty("previous_deployment");
    // The timeline shows the summary only, so the answers must be in it.
    for (const piece of ["Jane Roe", "Head of Platform", "11-25", "air-gapped: Yes", "1.8.0", "inst-org-1", "CodeRabbit"]) {
      expect(activity.summary).toContain(piece);
    }
  });

  describe("the account's idle clock", () => {
    const lastActivityAfter = async (current: string | null) => {
      const db = fakeDb({
        crm_companies: [company({ id: "acme", domain: "acme.com", deployment: "self_hosted", last_activity_at: current })],
      });
      await handleTrialSubmission(db.client, submission(), { apply: true });
      return db.tables.crm_companies[0].last_activity_at;
    };

    it("moves forward to the submission when that is later", async () => {
      expect(await lastActivityAfter("2026-08-01T00:00:00.000Z")).toBe("2026-09-18T14:02:11.000Z");
      expect(await lastActivityAfter(null)).toBe("2026-09-18T14:02:11.000Z");
    });

    it("stays put when the account was worked after the submission, as on a replay", async () => {
      expect(await lastActivityAfter("2026-09-25T09:00:00.000Z")).toBe("2026-09-25T09:00:00.000Z");
    });
  });

  it("records the same submission once, however many times it arrives", async () => {
    const db = fakeDb();
    const first = await handleTrialSubmission(db.client, submission(), { apply: true });
    const again = await handleTrialSubmission(db.client, submission(), { apply: true });

    expect(first.action).toBe("created");
    expect(again).toMatchObject({ action: "skipped", reason: "already_recorded", companyId: first.companyId });
    expect(db.tables.crm_companies).toHaveLength(1);
    expect(db.tables.crm_contacts).toHaveLength(1);
    expect(db.tables.crm_activities.filter((a) => a.kind === "trial_request")).toHaveLength(1);
  });

  it("merges the requester into existing people instead of adding or overwriting", async () => {
    const db = fakeDb({
      crm_companies: [company({ id: "acme", domain: "acme.com", deployment: "self_hosted" })],
      crm_contacts: [
        { id: "p1", company_id: "acme", name: "Jane R.", email: "JANE@acme.com", role: null, is_primary: true, created_at: "2026-01-01T00:00:00Z" },
        { id: "p2", company_id: "acme", name: "Bob", email: "bob@acme.com", role: "CTO", is_primary: false, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const o = await handleTrialSubmission(db.client, submission(), { apply: true });

    expect(o).toMatchObject({ action: "matched", contact: "updated" });
    expect(o).not.toHaveProperty("previousDeployment");
    expect(db.tables.crm_contacts).toHaveLength(2);
    expect(db.tables.crm_contacts[0]).toMatchObject({ name: "Jane R.", role: "Head of Platform", is_primary: true });
    expect(db.tables.crm_contacts[1]).toMatchObject({ name: "Bob", role: "CTO" });
  });
});

describe("POST /api/crm/tally", () => {
  const secret = "whsec-route";
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64");
  let db = fakeDb();

  beforeEach(() => {
    db = fakeDb();
    vi.resetModules();
    vi.doMock("@/lib/supabase-server", () => ({ getSupabaseServiceClient: () => db.client }));
    vi.stubEnv("TALLY_SIGNING_SECRET", secret);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/supabase-server");
  });

  const post = async (body: string, signature: string | null) => {
    const { POST } = await import("@/app/api/crm/tally/route");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature) headers["tally-signature"] = signature;
    return POST(new Request("http://test/api/crm/tally", { method: "POST", headers, body }));
  };

  it("rejects an unsigned or mis-signed delivery", async () => {
    const body = JSON.stringify(webhookPayload());
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, sign(`${body} `))).status).toBe(401);
    expect(db.writes).toEqual([]);
  });

  it("rejects every delivery while the secret is unset", async () => {
    vi.stubEnv("TALLY_SIGNING_SECRET", "");
    const body = JSON.stringify(webhookPayload());
    expect((await post(body, createHmac("sha256", "").update(body).digest("base64"))).status).toBe(401);
  });

  it("records a signed submission and answers 200 to anything it skips", async () => {
    const body = JSON.stringify(webhookPayload());
    const created = await post(body, sign(body));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ ok: true, action: "created" });

    const again = await post(body, sign(body));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ action: "skipped", reason: "already_recorded" });

    const other = JSON.stringify(webhookPayload({ formId: "npjK2P", submissionId: "sub-2" }));
    expect(await (await post(other, sign(other))).json()).toMatchObject({ action: "skipped", reason: "other_form" });
    expect(db.tables.crm_activities.filter((a) => a.kind === "trial_request")).toHaveLength(1);
  });

  it("answers a signed but unkeyable delivery with a 200 skip, so Tally stops retrying it", async () => {
    const payload = webhookPayload();
    const data: Record<string, unknown> = { ...payload.data };
    delete data.submissionId;
    delete data.responseId;
    const body = JSON.stringify({ ...payload, data });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: "skipped", reason: "unkeyable" });

    const notJson = "not json";
    expect((await post(notJson, sign(notJson))).status).toBe(200);
    expect(db.writes).toEqual([]);
  });
});

describe("the submission timestamp", () => {
  it("is canonical UTC ISO whatever form the payload used", () => {
    const payload = webhookPayload();
    const s = fromTallyWebhook({ ...payload, data: { ...payload.data, createdAt: "2026-09-18T11:02:11-03:00" } });
    expect(s?.submittedAt).toBe("2026-09-18T14:02:11.000Z");
  });

  it("falls back to the event time when the submission time does not parse", () => {
    const payload = webhookPayload();
    const s = fromTallyWebhook({ ...payload, data: { ...payload.data, createdAt: "yesterday-ish" } });
    expect(s?.submittedAt).toBe("2026-09-18T14:02:11.889Z");
  });
});
