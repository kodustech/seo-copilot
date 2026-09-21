import { describe, expect, it } from "vitest";

import { isTestActivity } from "../../lib/influencer/activities";

describe("isTestActivity", () => {
  it("recognizes only the explicit boolean marker", () => {
    expect(isTestActivity({ content_meta: { test_run: true } })).toBe(true);
    expect(isTestActivity({ content_meta: { test_run: false } })).toBe(false);
    expect(isTestActivity({ content_meta: { test_run: "true" } })).toBe(false);
    expect(isTestActivity({ content_meta: {} })).toBe(false);
  });
});
