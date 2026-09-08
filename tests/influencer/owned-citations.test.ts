/**
 * Matching a citation to one property of ours. Each site in the external-presence
 * plan is its own hypothesis, so "was a page of ours cited" is not the question —
 * "was THIS site cited" is, and github.com/kodustech has to be tellable apart from
 * the rest of github.com, which is a place we want to be listed on.
 */
import { describe, expect, it } from "vitest";

import { isOwnedProperty, urlMatchesProperty } from "../../lib/owned-domains";

describe("urlMatchesProperty", () => {
  it("matches a host property, subdomains included", () => {
    expect(urlMatchesProperty("https://aicodereview.io/blog/x", "aicodereview.io")).toBe(true);
    expect(urlMatchesProperty("https://www.aicodereview.io/", "aicodereview.io")).toBe(true);
    expect(urlMatchesProperty("https://blog.aicodereview.io/x", "aicodereview.io")).toBe(true);
    expect(urlMatchesProperty("https://codereviewbench.com/x", "aicodereview.io")).toBe(false);
  });

  it("tells our GitHub org apart from the rest of GitHub", () => {
    const ours = "github.com/kodustech";
    expect(urlMatchesProperty("https://github.com/kodustech/awesome-ai-code-review", ours)).toBe(true);
    expect(urlMatchesProperty("https://github.com/kodustech", ours)).toBe(true);
    expect(urlMatchesProperty("https://github.com/Nikita-Filonov/ai-review", ours)).toBe(false);
    expect(urlMatchesProperty("https://github.com/kodustech-fake/repo", ours)).toBe(false);
  });

  it("does not treat a host property as matching every path on a shared host", () => {
    expect(urlMatchesProperty("https://github.com/someone/repo", "github.com")).toBe(true);
    expect(isOwnedProperty("github.com")).toBe(false);
  });

  it("accepts the property written as a URL or with a trailing slash", () => {
    expect(urlMatchesProperty("https://aicodereview.io/x", "https://aicodereview.io/")).toBe(true);
    expect(urlMatchesProperty("https://github.com/kodustech/x", "github.com/kodustech/")).toBe(true);
  });

  it("'any' matches every property we own and nothing else", () => {
    expect(urlMatchesProperty("https://aicodereviews.io/tools/kodus", "any")).toBe(true);
    expect(urlMatchesProperty("https://github.com/kodustech/awesome", "any")).toBe(true);
    expect(urlMatchesProperty("https://codeant.ai/blog", "any")).toBe(false);
  });

  it("counts a site that answers on more than one domain as one property", () => {
    // The directory serves the same pages on both, and the assistants cite
    // whichever they found — matching one would read as half the presence.
    const site = "aicodereview.io, aicodereviews.io";
    expect(urlMatchesProperty("https://aicodereview.io/tools/kodus", site)).toBe(true);
    expect(urlMatchesProperty("https://www.aicodereviews.io/tools/kodus", site)).toBe(true);
    expect(urlMatchesProperty("https://aicodereview.cc/tools", site)).toBe(false);
  });

  it("refuses junk instead of matching everything", () => {
    expect(urlMatchesProperty("https://aicodereview.io/x", "")).toBe(false);
    expect(urlMatchesProperty("not a url", "aicodereview.io")).toBe(false);
  });
});

describe("isOwnedProperty", () => {
  it("accepts what we own, in either form", () => {
    expect(isOwnedProperty("aicodereview.io")).toBe(true);
    expect(isOwnedProperty("https://www.aicodereviews.io/")).toBe(true);
    expect(isOwnedProperty("github.com/kodustech")).toBe(true);
    expect(isOwnedProperty("docs.kodus.io")).toBe(true);
  });

  it("accepts a list only when every entry is ours", () => {
    expect(isOwnedProperty("aicodereview.io, aicodereviews.io")).toBe(true);
    expect(isOwnedProperty("aicodereview.io, coderabbit.ai")).toBe(false);
  });

  it("rejects a typo, so a measure cannot read zero forever and look like a failed test", () => {
    expect(isOwnedProperty("aicodereview.cc")).toBe(false);
    expect(isOwnedProperty("aicodereviw.io")).toBe(false);
    expect(isOwnedProperty("github.com")).toBe(false);
    expect(isOwnedProperty("")).toBe(false);
  });
});
