/**
 * Goals and bets edited from the MCP. A weekly operation goal (leads added,
 * posts published) has to be created as a recurring rule from the chat, keep
 * its funnel binding on every week the cron creates, and be stoppable. A bet
 * that keeps running into a new month has to move to that month's goal. And
 * deciding a bet must never wipe the notes recorded before the decision.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { prependBetNote, updateBet } from "../../lib/bets";
import {
  createRecurringGoal,
  repeatGoal,
  stopRepeatingGoal,
} from "../../lib/goal-recurrences";
import { currentMonthRange, currentWeekRange, type Goal } from "../../lib/goals";

type Row = Record<string, unknown>;

// Just enough of the Supabase query builder for these libs: insert, update
// and select with eq filters, ending in single or maybeSingle.
function fakeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { goals: [], goal_recurrences: [], bets: [], ...seed };
  let next = 1;

  function builder(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const filters: [string, unknown][] = [];
    const rows = () => (tables[table] ??= []);
    const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);

    const run = (): Row[] => {
      if (op === "insert") {
        const now = new Date().toISOString();
        const row = { id: `${table}-${next++}`, created_at: now, updated_at: now, ...payload };
        rows().push(row);
        return [row];
      }
      if (op === "update") {
        const hit = rows().filter(matches);
        for (const r of hit) Object.assign(r, payload);
        return hit;
      }
      return rows().filter(matches);
    };

    const api = {
      insert(row: Row) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: Row) {
        op = "update";
        payload = patch;
        return api;
      },
      select() {
        return api;
      },
      eq(k: string, v: unknown) {
        filters.push([k, v]);
        return api;
      },
      async single() {
        const [r] = run();
        return r ? { data: { ...r }, error: null } : { data: null, error: { message: "no rows" } };
      },
      async maybeSingle() {
        const [r] = run();
        return { data: r ? { ...r } : null, error: null };
      },
    };
    return api;
  }

  return { client: { from: builder } as unknown as SupabaseClient, tables };
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    title: "Leads novos no outbound por sinais (semana)",
    description: null,
    unit: "pessoas",
    kind: "output",
    targetCount: 50,
    currentCount: 0,
    periodStart: "2026-10-05",
    periodEnd: "2026-10-11",
    status: "active",
    priority: "medium",
    responsibleEmail: "owner@example.com",
    projectRef: null,
    notes: null,
    funnelMetric: "ob_contacts",
    recurrenceId: null,
    createdByEmail: "owner@example.com",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("period helpers", () => {
  it("keep the local calendar dates in a timezone ahead of UTC", () => {
    // Local midnight serialized with toISOString() used to land on the
    // previous day east of UTC, which made every weekly goal look like a
    // Sunday-Saturday week to the repeat check.
    const original = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      expect(currentWeekRange(new Date("2026-10-07T12:00:00"))).toEqual({ start: "2026-10-05", end: "2026-10-11" });
      expect(currentMonthRange(new Date("2026-10-15T12:00:00"))).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("createRecurringGoal", () => {
  it("creates the rule and this week's goal, keeping kind and the funnel binding", async () => {
    const { client, tables } = fakeClient();
    const { rule, goal: created } = await createRecurringGoal(
      client,
      { title: "Posts", kind: "input", targetCount: 2, cadence: "weekly", funnelMetric: "ob_contacts" },
      new Date("2026-10-07T12:00:00"),
    );

    expect(rule.cadence).toBe("weekly");
    expect(rule.funnelMetric).toBe("ob_contacts");
    expect(created).not.toBeNull();
    // Wednesday 2026-10-07 belongs to the Monday-Sunday week of the 5th.
    expect(created?.periodStart).toBe("2026-10-05");
    expect(created?.periodEnd).toBe("2026-10-11");
    expect(created?.kind).toBe("input");
    expect(created?.funnelMetric).toBe("ob_contacts");
    expect(created?.recurrenceId).toBe(rule.id);
    expect(tables.goals).toHaveLength(1);
  });

  it("leaves funnel_metric out of the insert when the rule has none", async () => {
    // Rules created from the goals page never pass it; the insert must not
    // depend on the column for them.
    const { client, tables } = fakeClient();
    await createRecurringGoal(client, { title: "Calls", cadence: "monthly" }, new Date("2026-10-15T12:00:00"));
    expect("funnel_metric" in tables.goal_recurrences[0]).toBe(false);
  });
});

describe("repeatGoal", () => {
  it("turns a one-off weekly goal into the first instance of a new rule", async () => {
    const { client, tables } = fakeClient({ goals: [{ id: "goal-1", recurrence_id: null }] });
    const { rule, goal: linked } = await repeatGoal(client, goal({ kind: "input" }), "weekly");

    expect(rule.title).toBe("Leads novos no outbound por sinais (semana)");
    expect(rule.targetCount).toBe(50);
    expect(rule.kind).toBe("input");
    expect(rule.funnelMetric).toBe("ob_contacts");
    expect(tables.goals[0].recurrence_id).toBe(rule.id);
    expect(linked).toBeDefined();
  });

  it("refuses a goal whose period is not one week", async () => {
    // A monthly goal cannot seed a weekly rule: the next instance would not
    // follow from it.
    const { client, tables } = fakeClient();
    await expect(
      repeatGoal(client, goal({ periodStart: "2026-10-01", periodEnd: "2026-10-31" }), "weekly"),
    ).rejects.toThrow(/2026-09-28 to 2026-10-04/);
    expect(tables.goal_recurrences).toHaveLength(0);
  });

  it("turns the existing rule back on instead of creating a second one", async () => {
    const { client, tables } = fakeClient({
      goal_recurrences: [{ id: "rule-1", title: "x", cadence: "weekly", active: false, kind: "input", target_count: 2 }],
    });
    const { rule } = await repeatGoal(client, goal({ recurrenceId: "rule-1" }), "weekly");
    expect(rule.active).toBe(true);
    expect(tables.goal_recurrences).toHaveLength(1);
  });
});

describe("stopRepeatingGoal", () => {
  it("deactivates the rule and keeps the goals already made", async () => {
    const { client, tables } = fakeClient({
      goal_recurrences: [{ id: "rule-1", title: "x", cadence: "weekly", active: true, kind: "input", target_count: 2 }],
      goals: [{ id: "goal-1", recurrence_id: "rule-1" }],
    });
    const rule = await stopRepeatingGoal(client, goal({ recurrenceId: "rule-1" }));
    expect(rule.active).toBe(false);
    expect(tables.goals).toHaveLength(1);
  });

  it("says so when the goal does not repeat", async () => {
    const { client } = fakeClient();
    await expect(stopRepeatingGoal(client, goal())).rejects.toThrow("does not repeat");
  });
});

describe("bets", () => {
  it("moves a bet to another goal", async () => {
    const { client, tables } = fakeClient({ bets: [{ id: "bet-1", goal_id: "goal-september" }] });
    const bet = await updateBet(client, "bet-1", { goalId: "goal-october" });
    expect(tables.bets[0].goal_id).toBe("goal-october");
    expect(bet.goalId).toBe("goal-october");
  });

  it("puts a decision note on top of the existing notes instead of replacing them", () => {
    expect(prependBetNote("Old reasoning.", " Became operation. ", "2026-10-01")).toBe(
      "2026-10-01: Became operation.\n\nOld reasoning.",
    );
    expect(prependBetNote(null, "First note", "2026-10-01")).toBe("2026-10-01: First note");
  });
});
