import { describe, expect, it, vi } from "vitest";

import {
  whyNoCorporateDomain,
  type CollectedOrg,
} from "@/lib/product-signals/collect";
import { evaluateOrg, MIN_DEVS } from "@/lib/product-signals/icp-gate";

/**
 * #260: a GitHub org with 18 members and 13 PR authors signed up from
 * gmail.com and never reached the CRM, because the gate rejected it on the
 * signup's address before it ever looked at the git org behind it.
 *
 * The fix admits exactly one extra population — free mail, connected git, at
 * least MIN_DEVS developers — and these tests pin both sides of that line:
 * who gets in, and every neighbour that must keep being rejected.
 */

function org(overrides: Partial<CollectedOrg> = {}): CollectedOrg {
  return {
    orgId: "org-1",
    orgName: "gfx-labs",
    orgType: "organization",
    signupAt: "2026-09-01T00:00:00Z",
    connectedGit: true,
    planType: null,
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
    codeHostMemberCount: null,
    codeHostMemberCountAt: null,
    prAuthorCount: null,
    prsReviewed30d: 0,
    suggestions30d: 0,
    suggestionsImplemented30d: 0,
    suggestionsPartial30d: 0,
    derivedDomain: null,
    noDomainReason: null,
    contacts: [],
    ...overrides,
  };
}

/** Everyone on personal mail, as collect.ts reports it. */
function freeMail(overrides: Partial<CollectedOrg> = {}): CollectedOrg {
  return org({ derivedDomain: null, noDomainReason: "free_mail", ...overrides });
}

function corporate(overrides: Partial<CollectedOrg> = {}): CollectedOrg {
  return org({ derivedDomain: "acme.com", noDomainReason: null, ...overrides });
}

/** The gate must never buy firmographics for a connected org; every test
 *  hands it this and checks it stayed untouched where that applies. */
function noEnrich() {
  return vi.fn(async () => null);
}

describe("evaluateOrg — free-mail teams on connected git (#260)", () => {
  it("creates a free-mail org with a connected git org of at least MIN_DEVS", async () => {
    const enrich = noEnrich();
    const d = await evaluateOrg(freeMail({ codeHostMemberCount: 18 }), "t0", {
      enrich,
    });

    expect(d).toMatchObject({
      create: true,
      reason: "pass_devs_no_domain",
      devCount: 18,
      devCountSource: "code_host",
    });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("counts PR authors the same way when the member count is missing", async () => {
    const d = await evaluateOrg(
      freeMail({ prAuthorCount: MIN_DEVS }),
      "t1",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({
      create: true,
      reason: "pass_devs_no_domain",
      devCount: MIN_DEVS,
      devCountSource: "pr_authors",
    });
  });

  it("keeps rejecting a free-mail org below MIN_DEVS, on its domain", async () => {
    // Deliberately domain_free_mail and not below_min_devs: the exception is
    // decided in full before the tier check, so an org it does not admit is
    // rejected on its domain at any age and the cleanup script still removes
    // it once it ages into t3. The dev count still rides on the decision.
    const d = await evaluateOrg(
      freeMail({ codeHostMemberCount: MIN_DEVS - 1 }),
      "t0",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({
      create: false,
      reason: "domain_free_mail",
      devCount: MIN_DEVS - 1,
    });
  });

  it("keeps rejecting a free-mail org with no team signal at all", async () => {
    const d = await evaluateOrg(freeMail(), "t1", { enrich: noEnrich() });

    expect(d).toMatchObject({ create: false, reason: "domain_free_mail" });
  });

  it("keeps rejecting a free-mail org that never connected git", async () => {
    // t2 has no team-size signal and never will; a stale member count on the
    // row must not smuggle it through either.
    const enrich = noEnrich();
    const d = await evaluateOrg(
      freeMail({ connectedGit: false, codeHostMemberCount: 40 }),
      "t2",
      { enrich },
    );

    expect(d).toMatchObject({ create: false, reason: "domain_free_mail" });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("keeps rejecting academic members however many developers there are", async () => {
    const d = await evaluateOrg(
      org({ noDomainReason: "academic", codeHostMemberCount: 60 }),
      "t0",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({ create: false, reason: "domain_academic" });
  });

  it("keeps rejecting internal members however many developers there are", async () => {
    const d = await evaluateOrg(
      org({ noDomainReason: "internal", codeHostMemberCount: 60 }),
      "t0",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({ create: false, reason: "domain_internal" });
  });

  it("keeps rejecting an org with no usable member address as no_domain", async () => {
    for (const noDomainReason of ["invalid", null] as const) {
      const d = await evaluateOrg(
        org({ noDomainReason, codeHostMemberCount: 60 }),
        "t0",
        { enrich: noEnrich() },
      );
      expect(d).toMatchObject({ create: false, reason: "no_domain" });
    }
  });

  it("still leaves a free-mail team out when its tier is not worked", async () => {
    // Admitted on the domain, then held by tier like any corporate team.
    for (const tier of ["t3", "customer", null]) {
      const d = await evaluateOrg(
        freeMail({ codeHostMemberCount: 18 }),
        tier,
        { enrich: noEnrich() },
      );
      expect(d).toMatchObject({ create: false, reason: "tier_not_worked" });
    }
  });

  it("does not let a small free-mail org survive by aging into t3", async () => {
    // The invariant "Domain first, tier second" exists for: an aged qq.com
    // signup must report its domain, not tier_not_worked.
    const d = await evaluateOrg(
      freeMail({ codeHostMemberCount: 3 }),
      "t3",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({ create: false, reason: "domain_free_mail" });
  });
});

describe("evaluateOrg — corporate path is unchanged", () => {
  it("passes a connected corporate org at MIN_DEVS as pass_devs", async () => {
    const enrich = noEnrich();
    const d = await evaluateOrg(
      corporate({ codeHostMemberCount: MIN_DEVS }),
      "t0",
      { enrich },
    );

    expect(d).toMatchObject({ create: true, reason: "pass_devs", devCount: MIN_DEVS });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("rejects a connected corporate org below MIN_DEVS", async () => {
    const d = await evaluateOrg(
      corporate({ codeHostMemberCount: MIN_DEVS - 1 }),
      "t1",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({ create: false, reason: "below_min_devs" });
  });

  it("reports no_team_signal for a connected corporate org with no dev count", async () => {
    const d = await evaluateOrg(corporate(), "t1", { enrich: noEnrich() });

    expect(d).toMatchObject({ create: false, reason: "no_team_signal" });
  });

  it("reports tier_not_worked for an aged corporate org", async () => {
    const d = await evaluateOrg(
      corporate({ codeHostMemberCount: 3 }),
      "t3",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({ create: false, reason: "tier_not_worked" });
  });

  it("still buys firmographics for a never-connected corporate org", async () => {
    const enrich = vi.fn(async (domain: string) => ({
      domain,
      employee_count: 120,
      industry: null,
      country: null,
      error: null,
      fetched_at: "2026-09-01T00:00:00Z",
    }));
    const d = await evaluateOrg(corporate({ connectedGit: false }), "t2", {
      enrich,
      firmographics: async () => ({ companyType: null, industry: null }),
    });

    expect(enrich).toHaveBeenCalledWith("acme.com");
    expect(d).toMatchObject({
      create: true,
      reason: "pass_employees",
      employeeCount: 120,
    });
  });

  it("rejects free mail carried in derivedDomain itself, as before", async () => {
    // collect.ts never puts a non-corporate domain there, but the gate
    // re-checks it; a never-connected one must not reach enrichment.
    const enrich = noEnrich();
    const d = await evaluateOrg(
      org({ derivedDomain: "gmail.com", connectedGit: false }),
      "t2",
      { enrich },
    );

    expect(d).toMatchObject({ create: false, reason: "domain_free_mail" });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("does not admit free mail carried in derivedDomain, even as a connected team", async () => {
    // The free-mail exception is for orgs with no derived domain at all. One
    // holding "gmail.com" would be created with the mail provider as its CRM
    // domain, so it keeps failing on the domain whatever its dev count.
    const d = await evaluateOrg(
      org({ derivedDomain: "gmail.com", codeHostMemberCount: MIN_DEVS + 5 }),
      "t0",
      { enrich: noEnrich() },
    );

    expect(d).toMatchObject({ create: false, reason: "domain_free_mail" });
  });
});

describe("whyNoCorporateDomain", () => {
  it("says free_mail when every member is on personal mail", () => {
    expect(
      whyNoCorporateDomain(["ana@gmail.com", "bo@hotmail.co.uk", "cy@qq.com"]),
    ).toBe("free_mail");
  });

  it("lets one academic member outrank any number of free-mail ones", () => {
    // A class where one student used the university address is still a class.
    expect(
      whyNoCorporateDomain(["ana@gmail.com", "bo@gmail.com", "cy@usp.br"]),
    ).toBe("academic");
  });

  it("lets an internal member outrank everything else", () => {
    expect(
      whyNoCorporateDomain(["ana@gmail.com", "bo@mit.edu", "qa@kodus.io"]),
    ).toBe("internal");
  });

  it("says invalid when no member has a usable address", () => {
    expect(whyNoCorporateDomain([])).toBe("invalid");
    expect(whyNoCorporateDomain(["not-an-email", "x@localhost"])).toBe("invalid");
  });
});
