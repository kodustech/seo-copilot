/**
 * The canonical guard. The model picks this URL, and a canonical tag hands the
 * ranking to whatever it points at — so a wrong one credits a competitor's page
 * for our own writing. Only sites we own are allowed through.
 */
import { describe, expect, it } from "vitest";

import { isOwnedCanonical } from "../../lib/influencer/url-guard";

describe("isOwnedCanonical", () => {
  it("accepts an article on one of our own sites", () => {
    expect(isOwnedCanonical("https://aicodereview.io/blog/ai-code-review-benchmarks")).toBe(true);
    expect(isOwnedCanonical("https://www.aicodereviews.io/tools/kodus")).toBe(true);
    expect(isOwnedCanonical("https://kodus.io/blog/whatever")).toBe(true);
    expect(isOwnedCanonical("  https://codereviewbench.com/  ")).toBe(true);
  });

  it("rejects a site we don't own, however close the name", () => {
    expect(isOwnedCanonical("https://aicodereview.cc/blog/post")).toBe(false);
    expect(isOwnedCanonical("https://coderabbit.ai/blog/post")).toBe(false);
    expect(isOwnedCanonical("https://dev.to/someone/article")).toBe(false);
  });

  it("rejects anything that isn't an http(s) URL", () => {
    expect(isOwnedCanonical("javascript:alert(1)")).toBe(false);
    expect(isOwnedCanonical("file:///etc/passwd")).toBe(false);
    expect(isOwnedCanonical("/blog/relative-path")).toBe(false);
    expect(isOwnedCanonical("")).toBe(false);
    expect(isOwnedCanonical("aicodereview.io/blog/post")).toBe(false);
  });

  it("is not fooled by our domain appearing elsewhere in the URL", () => {
    expect(isOwnedCanonical("https://evil.com/?u=https://kodus.io")).toBe(false);
    expect(isOwnedCanonical("https://kodus.io.evil.com/post")).toBe(false);
  });
});
