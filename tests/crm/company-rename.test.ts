import { describe, expect, it } from "vitest";

import { updateCompany } from "@/lib/crm";
import { updateCrmCompany } from "@/lib/ai/tools";

/**
 * Accounts the product-signals sweep creates are named after whatever the
 * signup carried — "Marcus-bazB50vSREnKSuGV", "Sonal's Org" — so the CRM list
 * is full of rows nobody recognises and large accounts go unworked.
 *
 * Correcting the name has one hard requirement: `org_id` is the only thing
 * tying the CRM row to the product organisation, and every usage signal is
 * resolved through it (see getProductSignals, which takes an org id and
 * nothing else). A rename that re-matched the account, or that shipped
 * `org_id` along in the same patch, would silently cut a live account off from
 * its own product data. These tests pin the patch that actually reaches the
 * database.
 */

type Row = Record<string, unknown>;

function companyRow(overrides: Row = {}): Row {
  return {
    id: "company-1",
    name: "Marcus-bazB50vSREnKSuGV",
    domain: "starian.com",
    org_id: "org-abc-123",
    status: "lead",
    priority: "medium",
    owner_email: null,
    industry: null,
    size: null,
    dev_count: 200,
    country: null,
    website: null,
    linkedin: null,
    arr: null,
    tags: [],
    enrichment: {},
    properties: {},
    tier: "t2",
    trigger: "healthy_usage",
    deployment: "cloud",
    source: "product",
    prep_status: "not_started",
    last_outreach_at: null,
    meeting_at: null,
    last_outreach_channel: null,
    outreach_sent_count: 0,
    notes: null,
    last_activity_at: null,
    archived_at: null,
    created_by_email: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * The narrowest stand-in for the Supabase client that updateCompany actually
 * uses: read the row, write a patch, read it back. It records every patch so a
 * test can assert on the columns that were touched, which is the only way to
 * show that a rename leaves org_id alone rather than writing it back unchanged.
 */
function fakeSupabase(row: Row) {
  const patches: Row[] = [];
  const inserts: { table: string; row: Row }[] = [];

  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { ...row }, error: null }),
          }),
        }),
        update(patch: Row) {
          patches.push({ ...patch });
          Object.assign(row, patch);
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { ...row }, error: null }),
              }),
              // logActivity's last_activity_at touch awaits .eq() directly.
              then: (resolve: (v: { error: null }) => void) =>
                resolve({ error: null }),
            }),
          };
        },
        insert(inserted: Row) {
          inserts.push({ table, row: inserted });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  // The stub implements the handful of calls updateCompany makes, not the
  // whole SupabaseClient surface.
  return { client: client as never, patches, inserts, row };
}

describe("renaming a CRM company", () => {
  it("writes the name and nothing else, so the product link survives", async () => {
    const { client, patches } = fakeSupabase(companyRow());

    const company = await updateCompany(client, "company-1", {
      name: "Starian",
    });

    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0])).toEqual(["name"]);
    expect(patches[0]).not.toHaveProperty("org_id");
    expect(patches[0]).not.toHaveProperty("domain");
    expect(company.name).toBe("Starian");
    expect(company.orgId).toBe("org-abc-123");
    expect(company.tier).toBe("t2");
  });

  it("trims the new name", async () => {
    const { client, patches } = fakeSupabase(companyRow());

    const company = await updateCompany(client, "company-1", {
      name: "  LG lugar de gente  ",
    });

    expect(patches[0].name).toBe("LG lugar de gente");
    expect(company.name).toBe("LG lugar de gente");
  });

  it("refuses to clear the name, and writes nothing when it does", async () => {
    for (const blank of ["", "   "]) {
      const { client, patches } = fakeSupabase(companyRow());
      await expect(
        updateCompany(client, "company-1", { name: blank }),
      ).rejects.toThrow(/name cannot be empty/);
      expect(patches).toHaveLength(0);
    }
  });

  it("leaves the name alone on a patch that does not carry one", async () => {
    const { client, patches, row } = fakeSupabase(companyRow());

    await updateCompany(client, "company-1", { notes: "asked for pricing" });

    expect(patches[0]).not.toHaveProperty("name");
    expect(row.name).toBe("Marcus-bazB50vSREnKSuGV");
  });

  it("keeps org_id editable on its own, separately from the name", async () => {
    const { client, patches } = fakeSupabase(companyRow());

    await updateCompany(client, "company-1", { orgId: "org-def-456" });

    expect(Object.keys(patches[0])).toEqual(["org_id"]);
    expect(patches[0].org_id).toBe("org-def-456");
  });
});

describe("updateCrmCompany tool schema", () => {
  const schema = updateCrmCompany.inputSchema as {
    safeParse: (v: unknown) => { success: boolean; data?: { name?: string } };
  };

  it("accepts a name", () => {
    const parsed = schema.safeParse({ id: "company-1", name: "Paytrack" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toBe("Paytrack");
  });

  it("still accepts a patch with no name", () => {
    expect(schema.safeParse({ id: "company-1", status: "qualified" }).success).toBe(
      true,
    );
  });

  it("has no way to null the name out", () => {
    // Unlike owner_email or notes, name is optional but not nullable: there is
    // no such thing as an account with no name, so the agent is not given a
    // spelling that asks for one.
    expect(schema.safeParse({ id: "company-1", name: null }).success).toBe(false);
  });
});
