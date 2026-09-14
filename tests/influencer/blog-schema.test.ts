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
import { buildBlogPayload } from "../../lib/influencer/publish";
import type { PersonaActivity, PersonaChannel } from "../../lib/influencer/types";

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

describe("buildBlogPayload", () => {
  const channel = (channel_config: Record<string, unknown>): PersonaChannel => ({
    id: "b1",
    persona_id: "p1",
    platform: "blog",
    external_handle: null,
    publish_via: "api",
    automation_level: "auto",
    max_posts_per_day: 1,
    max_replies_per_day: 0,
    credentials_ref: "vault:blog",
    channel_config,
    onboarding: {},
    status: "active",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });
  const draft = (content_meta: Record<string, unknown>): PersonaActivity => ({
    id: "a1",
    persona_id: "p1",
    channel_id: "b1",
    kind: "post",
    status: "approved",
    title: "Self-hosted AI review on GitLab, Azure DevOps, Bitbucket",
    content: "# no h1 here, the layout renders the title\n\nbody",
    content_meta,
    source_kind: "agent",
    source_ref: null,
    parent_activity_id: null,
    scheduled_at: null,
    published_at: null,
    external_id: null,
    external_url: null,
    error: null,
    approved_by: null,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  });

  const axisSite = channel({
    blog_api_url: "https://mergerequests.dev",
    blog_platforms: "gitlab, azure-devops, bitbucket, multi",
    blog_categories: "guide, comparison, reference, migration, explainer",
  });

  it("sends the platform a site organised by one requires", () => {
    const payload = buildBlogPayload(draft({ blog_platform: "multi", category: "comparison" }), axisSite);
    expect(payload.platform).toBe("multi");
    expect(payload.category).toBe("comparison");
  });

  it("refuses a draft that names none, naming the ones it could have", () => {
    // The whole bug: this used to ship and come back 422, 33 times over.
    expect(() => buildBlogPayload(draft({ category: "guide" }), axisSite)).toThrow(
      /gitlab, azure-devops, bitbucket, multi/,
    );
    expect(() => buildBlogPayload(draft({ blog_platform: "github" }), axisSite)).toThrow(/"github"/);
  });

  it("never sends a platform to a site that has no such axis", () => {
    // A stray blog_platform on a draft for the default site is a field nothing
    // reads there, and a stricter validator than ours would reject it outright.
    const payload = buildBlogPayload(draft({ blog_platform: "gitlab" }), channel({}));
    expect(payload).not.toHaveProperty("platform");
  });
});
