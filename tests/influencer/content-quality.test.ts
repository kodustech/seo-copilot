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

  it("rejects research access dates and process narration", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "Everything here was read from a vendor page on 2026-09-21.",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_research_process_note");
  });

  it("allows dates that are part of the subject", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "The project released this capability on 2026-09-21.",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_research_process_note");
  });

  it("does not flag ordinary subject sentences that contain review verbs and dates", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "The release was reviewed in the changelog and shipped on 2026-03-01.",
        "The read-only replica was enabled on 2026-01-01.",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_research_process_note");
  });

  it.each([
    "Accessed on 2026-09-21.",
    "Retrieved on 2026-09-21.",
    "(accessed on 2026-09-21)",
    "Consultado em 21/09/2026.",
    "Acessado no dia 21/09/2026.",
    "consultado no site em 21/09/2026.",
    "- Accessed on 2026-03-01",
    "* Retrieved on 2026-05-01",
    "1. Consultado em 21/09/2026",
    "> Acessado no dia 21/09/2026",
    "**Accessed on 2026-03-01**",
    "Sources: accessed on 2026-03-01",
    "> - **Retrieved on 2026-05-01**",
    "  __Consultado em 21/09/2026__",
    "Fonte: consultado em 21/09/2026",
    "### Accessed on 2026-05-01",
    "***Accessed on 2026-03-01***",
    "Sources consulted on 2026-03-01",
    "Reference: accessed on 2026-03-01",
  ])("rejects a bare access-date stamp: %s", (stamp) => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: ["## Context", body(270), "## Evidence", body(270), "## Decision", body(270), stamp].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_research_process_note");
  });

  it.each([
    "We accessed the official documentation on 2026-03-01.",
    "I retrieved the repository snapshot on 2026-01-15.",
    "Acessado no site oficial do projeto em 21/09/2026.",
    "Acessado no site oficial do projeto Kodus em 21/09/2026.",
    "We accessed the documentation for the official Kodus project on 2026-03-01.",
    "Acessado no site oficial\nem 21/09/2026.",
  ])("rejects a noun-based research access note: %s", (note) => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: ["## Context", body(270), "## Evidence", body(270), "## Decision", body(270), note].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_research_process_note");
  });

  it.each([
    "The report was consulted on 2026-02-10.",
    "Files retrieved on 2026-05-01 were audited.",
    "O arquivo acessado em 21/09/2026 foi removido.",
    "- Files retrieved on 2026-05-01 were audited.",
    "> O arquivo acessado em 21/09/2026 foi removido.",
    "**The report was consulted on 2026-02-10.**",
  ])("allows subject dates in ordinary prose: %s", (sentence) => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: ["## Context", body(270), "## Evidence", body(270), "## Decision", body(270), sentence].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_research_process_note");
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
        "![latency\nby region](https://cdn.example.com/latency.png)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });

  it("accepts valid image destinations and title delimiters", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Single quoted title](https://cdn.example.com/chart.png 'caption')",
        "![Parenthesized title](https://cdn.example.com/chart.png (caption))",
        "![Trailing whitespace](https://cdn.example.com/chart.png )",
        "![Angle bracket destination](<https://cdn.example.com/chart image.png>)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });

  it("accepts a non-blank multiline image title", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Chart](https://cdn.example.com/chart.png \"Figure\nfrom Q3\")",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });

  it("does not hide URLs in invalid image title or angle-destination syntax", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Blank line](https://cdn.example.com/chart.png\n\n\"caption\")",
        "![Invalid angle](<https://cdn.example.com/chart.png <https://example.com/report>)",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });

  it("accepts a title after a CRLF without accepting a blank line", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Chart](https://cdn.example.com/chart.png\r\n\"Figure 1\")",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });

  it("accepts a title after a lone CR line ending", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Chart](https://cdn.example.com/chart.png\r\"Figure 1\")",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
  });

  it("does not accept a blank title line made from CR characters", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Chart](https://cdn.example.com/chart.png\r\"Figure\r\r1\")",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });

  it("does not hide URLs after a block-level continuation in an image title", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: [
        "## Context",
        body(270),
        "## Evidence",
        body(270),
        "## Decision",
        body(270),
        "![Chart](https://cdn.example.com/chart.png \"Figure\n> quoted https://example.com/report\")",
      ].join("\n\n"),
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });

  it("does not hide URLs after HTML or thematic-break continuations in an image title", () => {
    for (const continuation of [
      "<div>https://example.com/html</div>",
      "***\nplain text",
    ]) {
      const issues = validateLongFormContent({
        platform: "blog",
        content: [
          "## Context",
          body(270),
          "## Evidence",
          body(270),
          "## Decision",
          body(270),
          `![Chart](https://cdn.example.com/chart.png \"Figure\n${continuation}\")`,
        ].join("\n\n"),
      });

      expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
    }
  });

  it.each([
    "<div>ok</div>",
    "<script>ok</script>",
    "<pre>ok</pre>",
    "<!-- comment -->",
    "<?instruction?>",
    "<![CDATA[text]]>",
    "</div>",
    "***\nplain text",
    "___\nplain text",
    "* * *\nplain text",
  ])("keeps the destination visible when a title crosses a real block start: %s", (continuation) => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: `![Chart](https://cdn.example.com/chart.png "Figure\n${continuation}")`,
    });
    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });

  it.each([
    "*** source https://example.com/report",
    "___ source https://example.com/report",
    "#tag",
    "14. item",
    "<span>caption</span>",
  ])("accepts an image title with a normal continuation: %s", (continuation) => {
    for (const [open, close] of [["\"", "\""], ["'", "'"], ["(", ")"]]) {
      const issues = validateLongFormContent({
        platform: "blog",
        content: `![Chart](https://cdn.example.com/chart.png ${open}Figure\n${continuation}${close})`,
      });
      expect(issues.map((issue) => issue.code)).not.toContain("long_form_raw_url");
    }
  });

  it("keeps URLs visible when a GFM table interrupts an image title", () => {
    const issues = validateLongFormContent({
      platform: "blog",
      content: "![Chart](https://cdn.example.com/chart.png \"Figure 1\n| a | b |\n| - | - |\n\")",
    });

    expect(issues.map((issue) => issue.code)).toContain("long_form_raw_url");
  });
});
