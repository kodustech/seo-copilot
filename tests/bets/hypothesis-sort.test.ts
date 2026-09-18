/**
 * Bets page order runs on the hypothesis number in the title ("H1.1 · ..."),
 * and the responsible badge resolves against seocopilot users. Both are pure
 * so the page, the MCP listBets tool and the API share one implementation.
 */
import { describe, expect, it } from "vitest";

import {
  betOwnerInitials,
  betOwnerLabel,
  canonicalOwnerEmail,
  compareBetsByHypothesis,
  parseHypothesisNumber,
} from "../../lib/bets";

describe("parseHypothesisNumber", () => {
  it("pulls dotted numbers off the H prefix", () => {
    expect(parseHypothesisNumber("H1.1 · Follow up")).toEqual([1, 1]);
    expect(parseHypothesisNumber("H2 · Something")).toEqual([2]);
    expect(parseHypothesisNumber("H1.10 · Tenth")).toEqual([1, 10]);
    expect(parseHypothesisNumber("  H3.2.1 - Deep")).toEqual([3, 2, 1]);
    expect(parseHypothesisNumber("h1.2 · lowercase")).toEqual([1, 2]);
  });

  it("returns null when the title carries no hypothesis number", () => {
    expect(parseHypothesisNumber("Follow up with replies")).toBeNull();
    expect(parseHypothesisNumber("")).toBeNull();
    expect(parseHypothesisNumber("SH1 · not a prefix")).toBeNull();
  });
});

describe("compareBetsByHypothesis", () => {
  const bet = (title: string, decisionAt = "2026-10-01") => ({ title, decisionAt });

  it("orders numerically, not lexicographically", () => {
    const titles = ["H1.10 · J", "H1.2 · B", "H2 · C", "H1 · A", "H1.1 · A1"];
    const sorted = [...titles].map((t) => bet(t)).sort(compareBetsByHypothesis).map((b) => b.title);
    expect(sorted).toEqual(["H1 · A", "H1.1 · A1", "H1.2 · B", "H1.10 · J", "H2 · C"]);
  });

  it("sends unnumbered titles to the end, alphabetically", () => {
    const sorted = [bet("Zebra"), bet("H1 · A"), bet("Apple")].sort(compareBetsByHypothesis).map((b) => b.title);
    expect(sorted).toEqual(["H1 · A", "Apple", "Zebra"]);
  });
});

describe("bet owner display", () => {
  const members = [
    { email: "gabriel@kodus.io", label: "Gabriel" },
    { email: "junior.sartori@kodus.io", label: "Junior" },
  ];

  it("prefers the member first name, case-insensitively", () => {
    expect(betOwnerLabel("Junior.Sartori@kodus.io", members)).toBe("Junior");
    expect(betOwnerLabel("edvaldo.freitas@kodus.io", members)).toBe("edvaldo.freitas");
    expect(betOwnerLabel(null, members)).toBeNull();
  });

  it("builds initials from the label, email parts as fallback", () => {
    expect(betOwnerInitials("gabriel@kodus.io", members)).toBe("GA");
    expect(betOwnerInitials("edvaldo.freitas@kodus.io", members)).toBe("EF");
    expect(betOwnerInitials(null, members)).toBe("–");
  });

  it("canonicalizes legacy mixed-case emails to the member case", () => {
    expect(canonicalOwnerEmail("Junior.Sartori@kodus.io", members)).toBe("junior.sartori@kodus.io");
    expect(canonicalOwnerEmail("gabriel@kodus.io", members)).toBe("gabriel@kodus.io");
    expect(canonicalOwnerEmail("someone@kodus.io", members)).toBe("someone@kodus.io");
    expect(canonicalOwnerEmail(null, members)).toBeNull();
  });
});
