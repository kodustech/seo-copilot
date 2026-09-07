/**
 * The scoreboard the fleet is actually judged on. What matters here is that the
 * brief says the true thing in both directions: silence when nothing of ours was
 * cited, and credit when something was — including for an unbranded property,
 * which is exactly the case the old owned-domain lists got wrong.
 */
import { describe, expect, it } from "vitest";

import type { AiPrompt, PromptEngineResult, VisibilitySummary } from "../../lib/ai-visibility";
import { formatVisibilityBrief } from "../../lib/influencer/visibility-brief";

function makeResult(overrides: Partial<PromptEngineResult> = {}): PromptEngineResult {
  return {
    engine: "perplexity",
    samples: 3,
    mentioned: 0,
    rate: 0,
    avgPosition: null,
    listSize: null,
    brandCited: false,
    competitors: [],
    citedDomains: [],
    extra: {},
    runs: [],
    error: null,
    ...overrides,
  };
}

function makePrompt(prompt: string): AiPrompt {
  return {
    id: prompt,
    prompt,
    language: "en",
    tags: [],
    active: true,
    createdByEmail: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function makeSummary(overrides: Partial<VisibilitySummary> = {}): VisibilitySummary {
  return {
    runOn: "2026-09-07",
    settings: {
      weekday: 1,
      engines: [],
      brandTerms: ["kodus"],
      competitorTerms: [],
      lastRunOn: "2026-09-07",
      updatedAt: "2026-09-07T00:00:00.000Z",
    },
    engines: [],
    prompts: [],
    domains: [],
    competitors: [],
    searches: [],
    totalCostUsd: 0,
    overallShare: 0.34,
    history: [],
    ...overrides,
  };
}

describe("formatVisibilityBrief", () => {
  it("says nothing when there has never been a run", () => {
    expect(formatVisibilityBrief(null)).toBe("");
    expect(formatVisibilityBrief(makeSummary({ runOn: null }))).toBe("");
  });

  it("names the buyer questions we were absent from", () => {
    const brief = formatVisibilityBrief(
      makeSummary({
        prompts: [
          { prompt: makePrompt("best AI code review for Bitbucket"), runs: { perplexity: makeResult() } },
          {
            prompt: makePrompt("Kodus vs CodeRabbit"),
            runs: { perplexity: makeResult({ mentioned: 2 }) },
          },
        ],
      }),
    );
    expect(brief).toContain("best AI code review for Bitbucket");
    expect(brief).not.toContain("Kodus vs CodeRabbit");
  });

  it("ignores a prompt whose only run errored — absent is not the same as unasked", () => {
    const brief = formatVisibilityBrief(
      makeSummary({
        prompts: [
          {
            prompt: makePrompt("timed out prompt"),
            runs: { perplexity: makeResult({ error: "429" }) },
          },
        ],
      }),
    );
    expect(brief).not.toContain("timed out prompt");
  });

  it("credits an unbranded property of ours when it is cited", () => {
    const brief = formatVisibilityBrief(
      makeSummary({
        prompts: [
          {
            prompt: makePrompt("self-hosted CodeRabbit alternatives"),
            runs: {
              perplexity: makeResult({ citedDomains: ["aicodereviews.io", "codeant.ai"] }),
            },
          },
        ],
      }),
    );
    expect(brief).toContain("aicodereviews.io (1)");
    expect(brief).not.toContain("codeant.ai");
    expect(brief).toContain("It works");
  });

  it("says plainly when none of our pages were cited", () => {
    const brief = formatVisibilityBrief(
      makeSummary({
        prompts: [
          { prompt: makePrompt("a question"), runs: { perplexity: makeResult({ citedDomains: ["reddit.com"] }) } },
        ],
      }),
    );
    expect(brief).toContain("None of our own pages were cited");
  });

  it("hands over the searches the assistants ran", () => {
    const brief = formatVisibilityBrief(
      makeSummary({
        searches: [
          { query: "best ai code review tools bitbucket", runs: 4, engines: ["perplexity"], prompts: 1 },
        ],
      }),
    );
    expect(brief).toContain("best ai code review tools bitbucket");
    expect(brief).toContain("a page that should exist");
  });
});
