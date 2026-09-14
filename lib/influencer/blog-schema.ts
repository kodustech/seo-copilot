/**
 * What a blog channel's content API will accept. The farm is a network of
 * sites, not one site with many authors, and they do not share a taxonomy:
 * aicodereview.io and agentwrotethis.dev file a post under a category alone,
 * while mergerequests.dev is organised by forge and refuses a post that does
 * not name one ("platform: must be one of gitlab, azure-devops, bitbucket,
 * multi" — a 422 on every publish, which is how this module came to exist).
 *
 * The vocabulary lives on the channel, next to blog_api_url and
 * blog_source_base, for the same reason those do: it belongs to the site's
 * repo, and hardcoding one site's answer here is what made every other site
 * publish wrong. An unconfigured channel gets the shared default, which is the
 * template every farm site starts from.
 */
import type { PersonaChannel } from "@/lib/influencer/types";

/** The category set the farm's site template ships with. */
export const DEFAULT_BLOG_CATEGORIES = [
  "best-of",
  "alternatives",
  "comparison",
  "guide",
  "explainer",
  "review",
] as const;

export type BlogSiteSchema = {
  /** Categories this site's API accepts; anything else 422s. */
  categories: string[];
  /** The site's second axis, when it has one — mergerequests.dev files every
   *  post under a forge. Null when the site has no such axis, which is the
   *  common case; a site that has one requires it. */
  platforms: string[] | null;
};

/** A config value written as a list, however it was typed in: an array, or a
 *  comma/newline-separated line from the connect form. */
function vocabulary(raw: unknown): string[] | null {
  const parts =
    typeof raw === "string"
      ? raw.split(/[,\n]/)
      : Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === "string")
        : null;
  if (!parts) return null;
  const cleaned = Array.from(
    new Set(parts.map((p) => p.trim().toLowerCase()).filter(Boolean)),
  );
  return cleaned.length ? cleaned : null;
}

export function blogSchemaFor(channel: Pick<PersonaChannel, "channel_config">): BlogSiteSchema {
  const config = channel.channel_config ?? {};
  return {
    categories: vocabulary(config.blog_categories) ?? [...DEFAULT_BLOG_CATEGORIES],
    platforms: vocabulary(config.blog_platforms),
  };
}

/**
 * The category to send: what the draft asked for when the site accepts it,
 * else the site's own fallback. Coercing is right — a category is a shelf, and
 * a piece on the wrong shelf still beats a piece that never publishes — but it
 * is only safe against the SITE's list. Against a hardcoded one it silently
 * rewrote every "reference" and "migration" post to "explainer".
 */
export function resolveBlogCategory(schema: BlogSiteSchema, requested: string | undefined): string {
  const asked = requested?.trim().toLowerCase() ?? "";
  if (asked && schema.categories.includes(asked)) return asked;
  return schema.categories.includes("explainer") ? "explainer" : schema.categories[0];
}
