/**
 * The list that decides "is this site ours". Getting it wrong is expensive in
 * one specific direction: an owned property the assistants cite comes back as a
 * third-party source to go pitch a link on.
 */
import { describe, expect, it } from "vitest";

import {
  BRAND_DOMAINS,
  OWNED_DOMAINS,
  isOwnedDomain,
  isOwnedUrl,
} from "../../lib/owned-domains";

describe("isOwnedDomain", () => {
  it("recognises the brand site and the unbranded properties alike", () => {
    expect(isOwnedDomain("kodus.io")).toBe(true);
    expect(isOwnedDomain("aicodereview.io")).toBe(true);
    expect(isOwnedDomain("aicodereviews.io")).toBe(true);
    expect(isOwnedDomain("codereviewbench.com")).toBe(true);
  });

  it("ignores www and a trailing dot, and matches subdomains", () => {
    expect(isOwnedDomain("www.aicodereviews.io")).toBe(true);
    expect(isOwnedDomain("kodus.io.")).toBe(true);
    expect(isOwnedDomain("blog.aicodereview.io")).toBe(true);
    expect(isOwnedDomain("DOCS.KODUS.IO")).toBe(true);
  });

  it("does not claim a domain that merely ends with our name", () => {
    expect(isOwnedDomain("notkodus.io")).toBe(false);
    expect(isOwnedDomain("aicodereview.cc")).toBe(false);
    expect(isOwnedDomain("codeant.ai")).toBe(false);
  });

  it("keeps unbranded properties out of the brand list", () => {
    // A citation of an editorial property is ours, but it is not a citation of
    // the Kodus brand — conflating them inflates the brand-cited metric.
    expect(BRAND_DOMAINS).not.toContain("aicodereview.io");
    expect(OWNED_DOMAINS).toContain("aicodereview.io");
  });
});

describe("isOwnedUrl", () => {
  it("recognises our pages on a host we don't own", () => {
    expect(isOwnedUrl("https://github.com/kodustech/awesome-ai-code-review")).toBe(true);
    expect(isOwnedUrl("https://github.com/kodustech")).toBe(true);
  });

  it("leaves the rest of that host alone — it is a real outreach target", () => {
    // github.com carries the awesome-lists we want to be listed on, so the
    // domain must stay pitchable even though our repos live there too.
    expect(isOwnedUrl("https://github.com/Nikita-Filonov/ai-review")).toBe(false);
    expect(isOwnedUrl("https://github.com/kodustech-fake/repo")).toBe(false);
    expect(isOwnedDomain("github.com")).toBe(false);
  });

  it("still recognises a whole site we own", () => {
    expect(isOwnedUrl("https://www.aicodereviews.io/tools/kodus")).toBe(true);
    expect(isOwnedUrl("https://codeant.ai/blogs/best-ai-code-review-tools")).toBe(false);
  });

  it("ignores a trailing dot, like isOwnedDomain does", () => {
    expect(isOwnedUrl("https://github.com./kodustech/awesome-ai-code-review")).toBe(true);
  });

  it("is not fooled by a path that merely looks like ours", () => {
    expect(isOwnedUrl("https://evil.com/github.com/kodustech")).toBe(false);
    expect(isOwnedUrl("not a url")).toBe(false);
  });
});
