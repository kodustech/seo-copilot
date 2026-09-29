import { describe, expect, it } from "vitest";

import { resolveDevCount } from "@/lib/product-signals/classify";
import type { CollectedOrg } from "@/lib/product-signals/collect";
import { evaluateOrg, MIN_DEVS } from "@/lib/product-signals/icp-gate";

/**
 * Team size is the larger of the connected git org's member count and the
 * distinct PR authors Kodus saw (#261). Members used to win whenever they were
 * above 0, so an org whose integration only exposes the user who installed it
 * — 1 member — was a team of one even with 59 people opening PRs, and the gate
 * rejected it as below_min_devs. These pin which number wins and which source
 * gets reported, since both are written to the CRM.
 */
describe("resolveDevCount", () => {
  it("takes PR authors when they outnumber a 1-member integration", () => {
    expect(resolveDevCount({ codeHostMemberCount: 1, prAuthorCount: 59 })).toEqual({
      devCount: 59,
      source: "pr_authors",
    });
  });

  it("takes members when they outnumber PR authors", () => {
    expect(resolveDevCount({ codeHostMemberCount: 30, prAuthorCount: 5 })).toEqual({
      devCount: 30,
      source: "code_host",
    });
  });

  it("reports code_host on a tie", () => {
    expect(resolveDevCount({ codeHostMemberCount: 18, prAuthorCount: 18 })).toEqual({
      devCount: 18,
      source: "code_host",
    });
  });

  it("uses PR authors alone for orgs that predate the member count", () => {
    expect(resolveDevCount({ codeHostMemberCount: null, prAuthorCount: 12 })).toEqual({
      devCount: 12,
      source: "pr_authors",
    });
  });

  it("returns none, not zero, when neither side knows anything", () => {
    expect(resolveDevCount({ codeHostMemberCount: 0, prAuthorCount: 0 })).toEqual({
      devCount: null,
      source: "none",
    });
    expect(resolveDevCount({ codeHostMemberCount: null, prAuthorCount: null })).toEqual({
      devCount: null,
      source: "none",
    });
  });
});

function connectedOrg(overrides: Partial<CollectedOrg> = {}): CollectedOrg {
  return {
    orgId: "org-one-visible-member",
    orgName: "Acme Logistics",
    orgType: "organization",
    signupAt: "2026-09-01T00:00:00Z",
    connectedGit: true,
    planType: "free_byok",
    subscriptionStatus: "active",
    trialEnd: null,
    totalLicenses: 1,
    assignedLicenses: 1,
    userCount: 1,
    reviews7d: 3,
    reviews30d: 12,
    lastReviewAt: "2026-09-28T00:00:00Z",
    skips30d: 0,
    lastSkipAt: null,
    topSkipReason: null,
    codeHostMemberCount: 1,
    codeHostMemberCountAt: "2026-09-01T00:00:00Z",
    prAuthorCount: 20,
    derivedDomain: "acme-logistics.com",
    contacts: [],
    prsReviewed30d: 10,
    suggestions30d: 40,
    suggestionsImplemented30d: 8,
    suggestionsPartial30d: 12,
    ...overrides,
  };
}

describe("evaluateOrg with a 1-member integration", () => {
  // Connected orgs are gated on dev count alone; enrichment is never consulted.
  const opts = {
    enrich: async () => {
      throw new Error("connected orgs must not buy firmographics");
    },
  };

  it("admits a connected t1 org with 1 member and 20 PR authors", async () => {
    const decision = await evaluateOrg(connectedOrg(), "t1", opts);
    expect(decision).toMatchObject({
      create: true,
      reason: "pass_devs",
      devCount: 20,
      devCountSource: "pr_authors",
    });
  });

  it("still rejects it when PR authors are below MIN_DEVS too", async () => {
    const decision = await evaluateOrg(
      connectedOrg({ prAuthorCount: MIN_DEVS - 1 }),
      "t1",
      opts,
    );
    expect(decision).toMatchObject({
      create: false,
      reason: "below_min_devs",
      devCount: MIN_DEVS - 1,
      devCountSource: "pr_authors",
    });
  });
});
