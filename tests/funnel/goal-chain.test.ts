import { describe, expect, it } from "vitest";

import type { Goal } from "@/lib/goals";
import { FUNNEL_METRICS } from "@/lib/funnel/goals";
import {
  CHAIN_LANES,
  buildGoalChain,
  elapsedShare,
  fedByGoals,
  feedsGoals,
  stageDepth,
  stageLabel,
} from "@/lib/funnel/goal-chain";

function goal(id: string, funnelMetric: string | null, period: [string, string] = ["2026-09-01", "2026-09-30"]): Goal {
  return {
    id,
    title: id,
    description: null,
    unit: null,
    kind: "output",
    targetCount: 10,
    currentCount: 0,
    periodStart: period[0],
    periodEnd: period[1],
    status: "active",
    priority: "medium",
    responsibleEmail: null,
    projectRef: null,
    notes: null,
    funnelMetric,
    recurrenceId: null,
    createdByEmail: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

// The September plan as it is registered: five goals on a stage, two off it.
const september = [
  goal("opps", "opportunities"),
  goal("visits", "visits"),
  goal("position", null),
  goal("meetings", "meetings"),
  goal("trial", "sh_trial"),
  goal("llm-share", null),
  goal("icp", "icp"),
];
const byId = (goals: Goal[]) => goals.map((g) => g.id);

describe("goal chain", () => {
  it("points each goal at the nearest goal downstream, not every one", () => {
    const find = (id: string) => september.find((g) => g.id === id)!;
    expect(byId(feedsGoals(find("visits"), september))).toEqual(["icp"]);
    // Conversations feed both: a meeting is a side stage, not a step.
    expect(byId(feedsGoals(find("icp"), september))).toEqual(["meetings", "opps"]);
    expect(byId(feedsGoals(find("trial"), september))).toEqual(["meetings", "opps"]);
    expect(byId(feedsGoals(find("meetings"), september))).toEqual(["opps"]);
    expect(byId(feedsGoals(find("opps"), september))).toEqual([]);
  });

  it("reads the other direction the same way", () => {
    const opps = september.find((g) => g.id === "opps")!;
    expect(byId(fedByGoals(opps, september)).sort()).toEqual(["icp", "meetings", "trial"]);
  });

  it("leaves goals without a stage off the chain", () => {
    const chain = buildGoalChain(september);
    expect(byId(chain.unplaced)).toEqual(["position", "llm-share"]);
    expect([...chain.endIds]).toEqual(["opps"]);
    expect(feedsGoals(september.find((g) => g.id === "position")!, september)).toEqual([]);
  });

  it("never drops a goal: every goal is either on a lane or unplaced", () => {
    const stray = goal("stray", "not_a_stage");
    const chain = buildGoalChain([...september, stray]);
    const onLanes = chain.lanes.flatMap((l) => Object.values(l.goalsByStage).flat());
    expect(onLanes.length + chain.unplaced.length).toBe(september.length + 1);
    expect(byId(chain.unplaced)).toContain("stray");
  });

  it("places every metric a goal can bind to on some lane", () => {
    const drawn = CHAIN_LANES.flatMap((l) => l.stages.map((s) => s.id));
    expect(drawn.sort()).toEqual(FUNNEL_METRICS.map((m) => m.id).sort());
  });

  it("does not link goals whose periods don't overlap", () => {
    const august = goal("aug-visits", "visits", ["2026-08-01", "2026-08-31"]);
    expect(feedsGoals(august, [...september, august])).toEqual([]);
  });

  it("keeps lanes in funnel order with only goal-able stages", () => {
    expect(CHAIN_LANES.map((l) => l.id)).toEqual(["self_hosted", "inbound", "outbound", "commercial"]);
    expect(CHAIN_LANES.find((l) => l.id === "inbound")!.stages.map((s) => s.id)).toEqual(["visits", "signups", "icp"]);
    expect(stageDepth("opportunities")).toBeGreaterThan(stageDepth("meetings"));
    expect(stageLabel("sh_trial")).toBe("Trial requests");
    expect(stageLabel("icp")).toBe("ICP");
  });

  it("measures how much of a running period has passed", () => {
    expect(elapsedShare(goal("x", null), new Date(2026, 8, 15))).toBeCloseTo(15 / 30);
    expect(elapsedShare(goal("x", null), new Date(2026, 9, 2))).toBeNull();
    expect(elapsedShare(goal("x", null), new Date(2026, 7, 20))).toBeNull();
  });
});
