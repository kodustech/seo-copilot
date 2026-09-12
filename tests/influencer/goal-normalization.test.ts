/**
 * What the goal editor is allowed to write. Goals are injected into the
 * persona's brief on every shift, so a malformed one does not surface as a
 * broken row: it steers the persona for a week and nobody notices. Everything
 * that cannot be measured or read is dropped here rather than repaired.
 */
import { describe, expect, it } from "vitest";

import { normalizeGoals } from "../../lib/influencer/goals";

describe("normalizeGoals", () => {
  it("keeps a well-formed goal of each type", () => {
    const out = normalizeGoals([
      { type: "posts_per_week", channel: "blog", target: 2, label: "Two pages a week" },
      { type: "followers", handle: "@tessainsley", target: 100, label: "Reach 100 followers" },
      { type: "custom", label: "Get cited by an assistant" },
    ]);
    expect(out).toHaveLength(3);
    // The handle is stored without the @, because that is what the X API takes.
    expect(out[1].handle).toBe("tessainsley");
  });

  it("drops a measurable goal that cannot be measured", () => {
    // Both of these would render as "ongoing" forever while claiming a number.
    expect(normalizeGoals([{ type: "posts_per_week", target: 2, label: "no channel" }])).toEqual([]);
    expect(normalizeGoals([{ type: "posts_per_week", channel: "blog", label: "no target" }])).toEqual([]);
    expect(normalizeGoals([{ type: "followers", target: 10, label: "no handle" }])).toEqual([]);
  });

  it("drops a goal with no label, because the label IS what the persona reads", () => {
    expect(normalizeGoals([{ type: "custom", label: "   " }])).toEqual([]);
    expect(normalizeGoals([{ type: "custom" }])).toEqual([]);
  });

  it("falls back to custom for an unknown type instead of storing it", () => {
    const out = normalizeGoals([{ type: "vibes", label: "Be good" }]);
    expect(out).toEqual([{ type: "custom", label: "Be good" }]);
  });

  it("refuses a target below 1, which the progress reading divides by", () => {
    const out = normalizeGoals([{ type: "custom", label: "x", target: 0 }]);
    expect(out[0].target).toBeUndefined();
    expect(normalizeGoals([{ type: "posts_per_week", channel: "blog", target: 0, label: "x" }])).toEqual([]);
  });

  it("truncates a runaway label and caps how many goals can be stored", () => {
    expect(normalizeGoals([{ type: "custom", label: "a".repeat(500) }])[0].label).toHaveLength(200);
    const many = Array.from({ length: 40 }, (_, i) => ({ type: "custom", label: `g${i}` }));
    expect(normalizeGoals(many)).toHaveLength(12);
  });

  it("caps what it keeps, not what it reads, so junk cannot starve the batch", () => {
    // Three malformed entries up front used to eat three of the twelve slots
    // and drop valid goals sitting past index 12.
    const input = [
      ...Array.from({ length: 3 }, () => ({ type: "custom" })),
      ...Array.from({ length: 20 }, (_, i) => ({ type: "custom", label: `g${i}` })),
    ];
    const out = normalizeGoals(input);
    expect(out).toHaveLength(12);
    expect(out[0].label).toBe("g0");
    expect(out[11].label).toBe("g11");
  });

  it("survives whatever the client actually sends", () => {
    expect(normalizeGoals(null)).toEqual([]);
    expect(normalizeGoals("goals")).toEqual([]);
    expect(normalizeGoals([null, undefined, 42, "x"])).toEqual([]);
  });
});
