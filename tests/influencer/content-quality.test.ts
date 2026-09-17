import { describe, expect, it } from "vitest";

import { validateLongFormContent } from "../../lib/influencer/content-quality";

function body(words = 820): string {
  return Array.from({ length: words }, (_, index) => `word${index}`).join(" ");
}

describe("validateLongFormContent", () => {
  it("does not apply long-form rules to short-form channels", () => {
    expect(
      validateLongFormContent({
        platform: "x",
        content: "A short post without headings or research links.",
      }),
    ).toEqual([]);
  });

  it("requires useful structure and linked research for articles", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: "A short article with https://example.com and no headings.",
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      "long_form_too_short",
      "long_form_headings_missing",
      "long_form_sources_missing",
      "long_form_raw_url",
    ]);
  });

  it("accepts a long article with contextual external links", () => {
    const issues = validateLongFormContent({
      platform: "devto",
      content: [
        "## Why this matters",
        body(330),
        "### The practical tradeoff",
        body(330),
        "## How to evaluate tools",
        body(330),
        "Read the [official GitLab documentation](https://docs.gitlab.com/ee/user/project/merge_requests/), the [Semgrep rule reference](https://semgrep.dev/docs/writing-rules/), and the [GitHub pull request documentation](https://docs.github.com/en/pull-requests).",
        "## Final recommendation",
        body(30),
      ].join("\n\n"),
    });

    expect(issues).toEqual([]);
  });

  it("rejects weak research anchors", () => {
    const issues = validateLongFormContent({
      platform: "hackernoon",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "Read [source](https://example.com/one) and [here](https://example.com/two).",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_weak_anchor");
  });

  it("does not count images as research links", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Benchmark chart](https://example.com/chart.png)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_sources_missing");
    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });

  it("handles nested brackets in image alt text without treating the image URL as raw", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Figure [1]](https://example.com/chart.png)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });

  it("keeps URLs in image alt text visible to the raw URL check", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![See https://example.com/page](https://cdn.example.com/chart.png)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });

  it("does not hide a raw URL after an image on the same line", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Figure [1]](https://cdn.example.com/chart.png https://example.com/report)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });

  it("keeps an unclosed image visible to the raw URL check", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Dashboard](https://cdn.example.com/dashboard.png",
        "Read https://example.com/report for the details.",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });

  it("accepts an image whose alt text spans multiple lines", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![latency",
        "by region](https://cdn.example.com/latency.png)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });
});
