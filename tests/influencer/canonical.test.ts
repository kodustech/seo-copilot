/**
 * The canonical guard. The model picks this URL, and a canonical tag hands the
 * ranking to whatever it points at — so a wrong one credits a competitor's page
 * for our own writing. Only sites we own are allowed through.
 */
import { describe, expect, it } from "vitest";

import { isOwnedCanonical, matchesOwnOriginal } from "../../lib/influencer/url-guard";

describe("isOwnedCanonical", () => {
  it("accepts an article on one of our own sites", () => {
    expect(isOwnedCanonical("https://aicodereview.io/blog/ai-code-review-benchmarks")).toBe(true);
    expect(isOwnedCanonical("https://www.aicodereviews.io/tools/kodus")).toBe(true);
    expect(isOwnedCanonical("https://kodus.io/blog/whatever")).toBe(true);
    expect(isOwnedCanonical("  https://codereviewbench.com/  ")).toBe(true);
  });

  it("accepts the newer network sites, so their crossposts can point home", () => {
    // A persona publishes the original here and syndicates it. Leave a site out
    // of the owned list and every dev.to crosspost and Medium import from it is
    // refused at this guard.
    expect(isOwnedCanonical("https://agentwrotethis.dev/blog/some-post")).toBe(true);
    expect(isOwnedCanonical("https://mergerequests.dev/blog/some-post")).toBe(true);
    expect(isOwnedCanonical("https://www.mergerequests.dev/platform/gitlab")).toBe(true);
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

describe("matchesOwnOriginal", () => {
  const published = [
    "https://aicodereview.io/blog/ai-code-review-benchmarks/",
    "https://dev.to/noobz4ro/how-i-actually-eval-ai-code-review-tools-621",
  ];

  it("accepts the exact URL of something the persona published", () => {
    expect(matchesOwnOriginal(published[0], published)).toBe(true);
    expect(matchesOwnOriginal(published[1], published)).toBe(true);
  });

  it("rejects a page on our domain that was never written", () => {
    // Owning the domain only closes the competitor case. A canonical pointing
    // at a page that doesn't exist hands the ranking to a 404.
    expect(matchesOwnOriginal("https://aicodereview.io/blog/never-written", published)).toBe(false);
    expect(matchesOwnOriginal("https://aicodereview.io/", published)).toBe(false);
    expect(matchesOwnOriginal("https://kodus.io/blog/someone-elses-post", published)).toBe(false);
  });

  it("forgives a trailing slash, and case where the spec says to", () => {
    // Scheme and host are case-insensitive; an API returning /slug/ and a model
    // copying /slug are the same page.
    expect(matchesOwnOriginal("https://aicodereview.io/blog/ai-code-review-benchmarks", published)).toBe(true);
    expect(matchesOwnOriginal("  HTTPS://AICODEREVIEW.IO/blog/ai-code-review-benchmarks/  ", published)).toBe(true);
  });

  it("does not forgive a difference in the path's case", () => {
    // The path is case-sensitive. Accepting one that differs only in case would
    // send the ranking to a 404 on any host that means it.
    expect(
      matchesOwnOriginal("https://aicodereview.io/blog/AI-Code-Review-Benchmarks", published),
    ).toBe(false);
  });

  it("treats a different port as a different origin", () => {
    // The raw string is what gets written as the tag, so approving :8443
    // against the real page would point the canonical at another service.
    expect(
      matchesOwnOriginal("https://aicodereview.io:8443/blog/ai-code-review-benchmarks", published),
    ).toBe(false);
  });

  it("accepts a spelled-out default port and a trailing dot", () => {
    // The parser drops :443 on https, and a trailing dot is the same host.
    expect(
      matchesOwnOriginal("https://aicodereview.io:443/blog/ai-code-review-benchmarks", published),
    ).toBe(true);
    expect(
      matchesOwnOriginal("https://aicodereview.io./blog/ai-code-review-benchmarks", published),
    ).toBe(true);
  });

  it("rejects everything when the persona has published nothing", () => {
    expect(matchesOwnOriginal(published[0], [])).toBe(false);
    expect(matchesOwnOriginal("", published)).toBe(false);
  });
});
