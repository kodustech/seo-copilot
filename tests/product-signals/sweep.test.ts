import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectedOrg } from "@/lib/product-signals/collect";

vi.mock("@/lib/product-signals/collect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/product-signals/collect")>()),
  collectOrgFacts: vi.fn(),
}));
vi.mock("@/lib/crm", () => ({
  createCompany: vi.fn(),
  createContact: vi.fn(),
  logActivity: vi.fn(),
}));

import { createCompany, createContact } from "@/lib/crm";
import { collectOrgFacts } from "@/lib/product-signals/collect";
import { runProductSignalsSweep } from "@/lib/product-signals/sweep";

/**
 * What the sweep does with a free-mail team the gate admits (#260): create the
 * account without a domain, named after the org and linked by org_id — and
 * never a second one when an account already carries that org_id, which is the
 * only identity a domainless account has.
 */

type Row = Record<string, unknown>;

function org(overrides: Partial<CollectedOrg> = {}): CollectedOrg {
  return {
    orgId: "org-free",
    orgName: "gfx-labs",
    orgType: "organization",
    signupAt: "2026-09-01T00:00:00Z",
    connectedGit: true,
    planType: null,
    // In trial with no end date → t0 on any clock, so the test does not age.
    subscriptionStatus: "trial",
    trialEnd: null,
    totalLicenses: null,
    assignedLicenses: null,
    userCount: 1,
    reviews7d: 0,
    reviews30d: 0,
    lastReviewAt: null,
    skips30d: 0,
    lastSkipAt: null,
    topSkipReason: null,
    codeHostMemberCount: 18,
    codeHostMemberCountAt: null,
    prAuthorCount: 13,
    prsReviewed30d: 0,
    suggestions30d: 0,
    suggestionsImplemented30d: 0,
    suggestionsPartial30d: 0,
    derivedDomain: null,
    noDomainReason: "free_mail",
    contacts: [
      { email: "ana@gmail.com", name: "Ana" },
      { email: "bo@gmail.com", name: null },
    ],
    ...overrides,
  };
}

function companyRef(overrides: Row = {}): Row {
  return {
    id: "company-1",
    org_id: null,
    domain: null,
    tier: null,
    trigger: null,
    dev_count: null,
    archived_at: null,
    ...overrides,
  };
}

/**
 * The calls the sweep itself makes on the client: paged selects, the
 * product_signals upserts/inserts, and crm_companies updates. Account and
 * contact creation go through the mocked lib/crm and never reach it.
 */
function fakeClient(companies: Row[]) {
  const updates: { table: string; patch: Row; id: unknown }[] = [];
  const client = {
    from(table: string) {
      return {
        select: () => ({
          range: async (from: number) => ({
            data: from === 0 && table === "crm_companies" ? companies : [],
            error: null,
          }),
        }),
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null }),
        update(patch: Row) {
          const entry = { table, patch, id: undefined as unknown };
          updates.push(entry);
          const chain = {
            eq(column: string, value: unknown) {
              if (column === "id") entry.id = value;
              return chain;
            },
            is: () => chain,
            then: (
              resolve: (v: { error: null }) => unknown,
              reject?: (e: unknown) => unknown,
            ) => Promise.resolve({ error: null }).then(resolve, reject),
          };
          return chain;
        },
      };
    },
  };
  return { client: client as never, updates };
}

function tierWrites(updates: { table: string; patch: Row; id: unknown }[]) {
  return updates
    .filter((u) => u.table === "crm_companies" && "tier" in u.patch)
    .map((u) => ({ id: u.id, tier: u.patch.tier }));
}

beforeEach(() => {
  vi.mocked(collectOrgFacts).mockReset();
  vi.mocked(createCompany).mockReset();
  vi.mocked(createContact).mockReset();
  vi.mocked(createCompany).mockResolvedValue({ id: "company-new" } as never);
});

describe("product-signals sweep — free-mail teams (#260)", () => {
  it("creates the account without a domain, named after the org and linked by org_id", async () => {
    vi.mocked(collectOrgFacts).mockResolvedValue([org()]);
    const { client, updates } = fakeClient([]);

    const summary = await runProductSignalsSweep(client);

    expect(summary.errors).toEqual([]);
    expect(summary.companiesCreated).toBe(1);
    expect(summary.gate).toEqual({ pass_devs_no_domain: 1 });
    expect(createCompany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createCompany).mock.calls[0][1]).toMatchObject({
      name: "gfx-labs",
      domain: null,
      orgId: "org-free",
      source: "product",
      devCount: 18,
      enrichment: { icp_gate: "pass_devs_no_domain", dev_count_source: "code_host" },
    });

    // The gmail addresses are the people; with no domain there is nothing to
    // filter them against.
    expect(vi.mocked(createContact).mock.calls.map((c) => c[2])).toEqual([
      { name: "Ana", email: "ana@gmail.com", isPrimary: true },
      { name: "bo", email: "bo@gmail.com", isPrimary: false },
    ]);

    expect(tierWrites(updates)).toEqual([{ id: "company-new", tier: "t0" }]);
  });

  it("only takes real free-mail addresses as contacts on a domainless account", async () => {
    // bo@gmail and cy@localhost classify "invalid", so the org is still
    // admitted on ana's gmail — but neither may become a contact, least of all
    // the primary one.
    vi.mocked(collectOrgFacts).mockResolvedValue([
      org({
        contacts: [
          { email: "bo@gmail", name: "Bo" },
          { email: "cy@localhost", name: "Cy" },
          { email: "ana@gmail.com", name: "Ana" },
        ],
      }),
    ]);
    const { client } = fakeClient([]);

    await runProductSignalsSweep(client);

    expect(vi.mocked(createContact).mock.calls.map((c) => c[2])).toEqual([
      { name: "Ana", email: "ana@gmail.com", isPrimary: true },
    ]);
  });

  it("never takes a code host's noreply address as a contact", async () => {
    // It classifies free_mail (github.com is never a company), but nobody
    // reads it, so it must not become the primary contact ahead of a person.
    vi.mocked(collectOrgFacts).mockResolvedValue([
      org({
        contacts: [
          { email: "12345+dev@users.noreply.github.com", name: "Dev" },
          { email: "ana@gmail.com", name: "Ana" },
        ],
      }),
    ]);
    const { client } = fakeClient([]);

    await runProductSignalsSweep(client);

    expect(vi.mocked(createContact).mock.calls.map((c) => c[2])).toEqual([
      { name: "Ana", email: "ana@gmail.com", isPrimary: true },
    ]);
  });

  it("still takes only the derived domain's addresses on a corporate account", async () => {
    vi.mocked(collectOrgFacts).mockResolvedValue([
      org({
        derivedDomain: "acme.com",
        noDomainReason: null,
        contacts: [
          { email: "ana@acme.com", name: "Ana" },
          { email: "bo@gmail.com", name: "Bo" },
        ],
      }),
    ]);
    const { client } = fakeClient([]);

    const summary = await runProductSignalsSweep(client);

    expect(summary.gate).toEqual({ pass_devs: 1 });
    expect(vi.mocked(createCompany).mock.calls[0][1]).toMatchObject({
      domain: "acme.com",
    });
    expect(vi.mocked(createContact).mock.calls.map((c) => c[2])).toEqual([
      { name: "Ana", email: "ana@acme.com", isPrimary: true },
    ]);
  });

  it("falls back to the org id when the org has no name", async () => {
    vi.mocked(collectOrgFacts).mockResolvedValue([org({ orgName: "  " })]);
    const { client } = fakeClient([]);

    await runProductSignalsSweep(client);

    expect(vi.mocked(createCompany).mock.calls[0][1]).toMatchObject({
      name: "Org org-free",
      domain: null,
    });
  });

  it("reuses an account already linked by org_id instead of creating a second one", async () => {
    // The two orgs in #260 were created by hand on 2026-09-24 with a domain a
    // human found and the org_id set. The sweep must land on that account.
    vi.mocked(collectOrgFacts).mockResolvedValue([org()]);
    const { client, updates } = fakeClient([
      companyRef({ id: "company-hand", org_id: "org-free", domain: "oku.trade" }),
    ]);

    const summary = await runProductSignalsSweep(client);

    expect(createCompany).not.toHaveBeenCalled();
    expect(summary.companiesCreated).toBe(0);
    expect(summary.gate).toEqual({});
    expect(tierWrites(updates)).toEqual([{ id: "company-hand", tier: "t0" }]);
  });

  it("does not create a free-mail org below MIN_DEVS", async () => {
    vi.mocked(collectOrgFacts).mockResolvedValue([
      org({ codeHostMemberCount: 4, prAuthorCount: 2 }),
    ]);
    const { client } = fakeClient([]);

    const summary = await runProductSignalsSweep(client);

    expect(createCompany).not.toHaveBeenCalled();
    expect(summary.gate).toEqual({ domain_free_mail: 1 });
  });

  it("keeps a domainless account and a domain account apart once the org gains that domain", async () => {
    // org-free's account was created without a domain. A member on acme.com
    // later joins it, and org-acme's account already holds acme.com. Each org
    // writes to its own linked account, so they must not share an election:
    // keyed on the same domain, one of the two accounts would stop getting
    // its tier.
    vi.mocked(collectOrgFacts).mockResolvedValue([
      org({ derivedDomain: "acme.com", noDomainReason: null }),
      org({
        orgId: "org-acme",
        orgName: "acme",
        derivedDomain: "acme.com",
        noDomainReason: null,
        signupAt: "2026-08-01T00:00:00Z",
      }),
    ]);
    const { client, updates } = fakeClient([
      companyRef({ id: "company-free", org_id: "org-free", domain: null }),
      companyRef({ id: "company-acme", org_id: "org-acme", domain: "acme.com" }),
    ]);

    const summary = await runProductSignalsSweep(client);

    expect(summary.orgsSharingAccount).toBe(0);
    expect(createCompany).not.toHaveBeenCalled();
    expect(tierWrites(updates).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { id: "company-acme", tier: "t0" },
      { id: "company-free", tier: "t0" },
    ]);
  });
});
