/**
 * The farm's sites do not share a taxonomy. mergerequests.dev files every post
 * under a forge and refuses one that names none; aicodereview.io has no such
 * axis and a different category set. Hardcoding one site's answer 422'd every
 * post sent to the other, so the vocabulary is read from the channel.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BLOG_CATEGORIES,
  blogSchemaFor,
  resolveBlogCategory,
} from "../../lib/influencer/blog-schema";

const channel = (channel_config: Record<string, unknown>) => ({ channel_config });

describe("blogSchemaFor", () => {
  it("falls back to the template's categories and no platform axis", () => {
    const schema = blogSchemaFor(channel({}));
    expect(schema.categories).toEqual([...DEFAULT_BLOG_CATEGORIES]);
    expect(schema.platforms).toBeNull();
  });

  it("reads a vocabulary typed into the connect form as one line", () => {
    const schema = blogSchemaFor(
      channel({
        blog_categories: "guide, comparison, reference, migration, explainer",
        blog_platforms: "gitlab, azure-devops, Bitbucket , multi",
      }),
    );
    expect(schema.categories).toEqual([
      "guide",
      "comparison",
      "reference",
      "migration",
      "explainer",
    ]);
    // Lowercased and de-spaced: the API compares against its own literals.
    expect(schema.platforms).toEqual(["gitlab", "azure-devops", "bitbucket", "multi"]);
  });

  it("reads one stored as an array, and ignores an empty or junk value", () => {
    expect(blogSchemaFor(channel({ blog_platforms: ["gitlab", "multi"] })).platforms).toEqual([
      "gitlab",
      "multi",
    ]);
    expect(blogSchemaFor(channel({ blog_platforms: "  ,  " })).platforms).toBeNull();
    expect(blogSchemaFor(channel({ blog_platforms: 42 })).platforms).toBeNull();
    expect(blogSchemaFor(channel({ blog_categories: [] })).categories).toEqual([
      ...DEFAULT_BLOG_CATEGORIES,
    ]);
  });
});

describe("resolveBlogCategory", () => {
  it("keeps a category the site accepts", () => {
    const schema = blogSchemaFor(channel({ blog_categories: "guide, comparison, reference" }));
    expect(resolveBlogCategory(schema, "reference")).toBe("reference");
    expect(resolveBlogCategory(schema, " Comparison ")).toBe("comparison");
  });

  it("coerces one the site does not, rather than failing the post", () => {
    const schema = blogSchemaFor(channel({}));
    expect(resolveBlogCategory(schema, "migration")).toBe("explainer");
    expect(resolveBlogCategory(schema, undefined)).toBe("explainer");
  });

  it("falls back to the site's first category when it has no explainer", () => {
    const schema = blogSchemaFor(channel({ blog_categories: "reference, migration" }));
    expect(resolveBlogCategory(schema, "best-of")).toBe("reference");
  });
});
