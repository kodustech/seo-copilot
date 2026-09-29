import { describe, expect, it } from "vitest";

import { HUMAN_KINDS, selfHostedStages } from "@/lib/funnel/metrics";

/**
 * sh_trial used to be "self-hosted accounts created by the webhook", which the
 * trial form never reached, so September read 0 against 6 requests. It now
 * counts accounts with a trial_request activity dated in the period (#263).
 * sh_found must keep meaning what it meant.
 */

type Account = { id: string; name: string; deployment: string | null; source: string | null; created_at: string };

const account = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  name: id,
  deployment: "self_hosted",
  source: "webhook",
  created_at: "2026-09-10T12:00:00.000+00:00",
  ...over,
});

describe("sh_trial", () => {
  it("counts distinct accounts that asked in the period, dated by the request", () => {
    const crm = [
      account("new-from-form"),
      // Created long before and by hand: the request is what counts.
      account("existing", { source: "manual", deployment: "self_hosted", created_at: "2025-11-01T00:00:00Z" }),
      account("asked-in-august"),
    ];
    const { trial } = selfHostedStages(
      crm,
      [
        { company_id: "asked-in-august", created_at: "2026-08-31T23:59:59.000+00:00" },
        { company_id: "new-from-form", created_at: "2026-09-02T10:00:00.000+00:00" },
        { company_id: "existing", created_at: "2026-09-05T10:00:00.000+00:00" },
        // Asking twice is one hand raised.
        { company_id: "new-from-form", created_at: "2026-09-20T10:00:00.000+00:00" },
        { company_id: "existing", created_at: "2026-10-01T00:00:00.000+00:00" },
      ],
      "2026-09-01",
      "2026-10-01",
    );
    expect(trial.map((t) => [t.company.id, t.askedAt.slice(0, 10)])).toEqual([
      ["new-from-form", "2026-09-02"],
      ["existing", "2026-09-05"],
    ]);
  });

  it("leaves out an account that is not on the CRM list (excluded)", () => {
    const { trial } = selfHostedStages(
      [account("listed")],
      [
        { company_id: "listed", created_at: "2026-09-02T10:00:00Z" },
        { company_id: "excluded", created_at: "2026-09-03T10:00:00Z" },
      ],
      "2026-09-01",
      "2026-10-01",
    );
    expect(trial.map((t) => t.company.id)).toEqual(["listed"]);
  });
});

describe("sh_found", () => {
  it("still counts self-hosted accounts created in the period by hand or PostHog, and not the form's", () => {
    const crm = [
      account("manual", { source: "manual" }),
      account("posthog", { source: "product" }),
      account("form", { source: "webhook" }),
      account("cloud", { source: "manual", deployment: "cloud" }),
      account("last-month", { source: "manual", created_at: "2026-08-20T00:00:00Z" }),
    ];
    // A request from the manual account does not move it out of sh_found.
    const { found } = selfHostedStages(
      crm,
      [{ company_id: "manual", created_at: "2026-09-12T00:00:00Z" }],
      "2026-09-01",
      "2026-10-01",
    );
    expect(found.map((c) => c.id)).toEqual(["manual", "posthog"]);
  });
});

describe("touch within 48 h", () => {
  it("does not count a trial request as a touch by the team", () => {
    expect(HUMAN_KINDS).not.toContain("trial_request");
  });
});
