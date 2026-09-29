import { describe, expect, it } from "vitest";

import { analyzeAnswer, runToRetryToday, type AiVisibilitySettings } from "../lib/ai-visibility";

describe("AI visibility answer analysis", () => {
  it("does not count a cited bare domain as a brand mention", () => {
    const result = analyzeAnswer(
      "Qodo is a strong option for Bitbucket. (kodus.io)",
      [{ title: "Kodus", url: "https://kodus.io/compare/bitbucket" }],
      ["kodus"],
      [],
    );

    expect(result.mentioned).toBe(false);
    expect(result.brandCited).toBe(true);
  });

  it("counts the brand when it is visibly named, even if linked", () => {
    const result = analyzeAnswer(
      "Kodus is one of the tools I would consider.",
      [{ title: "Kodus", url: "https://kodus.io" }],
      ["kodus"],
      [],
    );

    expect(result.mentioned).toBe(true);
  });

  it("keeps a human link label as a mention and ignores its URL target", () => {
    const result = analyzeAnswer(
      "A good option is [Kodus](https://kodus.io).",
      [{ title: "Kodus", url: "https://kodus.io" }],
      ["kodus"],
      [],
    );

    expect(result.mentioned).toBe(true);
  });
});

describe("AI visibility retry day", () => {
  const settings = (lastRunOn: string | null): AiVisibilitySettings => ({
    weekday: 1,
    engines: [],
    brandTerms: [],
    competitorTerms: [],
    lastRunOn,
    updatedAt: "2026-09-28T07:14:41Z",
  });

  it("retries the run on the day after it", () => {
    expect(runToRetryToday(settings("2026-09-28"), new Date("2026-09-29T07:00:00Z"))).toBe("2026-09-28");
  });

  it("does not retry on the run day or two days after", () => {
    expect(runToRetryToday(settings("2026-09-28"), new Date("2026-09-28T07:00:00Z"))).toBeNull();
    expect(runToRetryToday(settings("2026-09-28"), new Date("2026-09-30T07:00:00Z"))).toBeNull();
  });

  it("crosses a month boundary", () => {
    expect(runToRetryToday(settings("2026-09-30"), new Date("2026-10-01T00:30:00Z"))).toBe("2026-09-30");
  });

  it("does nothing before the first run", () => {
    expect(runToRetryToday(settings(null), new Date("2026-09-29T07:00:00Z"))).toBeNull();
  });
});
