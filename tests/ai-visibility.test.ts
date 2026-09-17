import { describe, expect, it } from "vitest";

import { analyzeAnswer } from "../lib/ai-visibility";

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
