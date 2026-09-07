/**
 * Every web property we own, in one place. Four copies of this list had drifted
 * apart across ai-visibility, brand-mentions and social-monitoring, and none of
 * them knew about aicodereview.io — the site the influencer fleet publishes to.
 * The cost is not cosmetic: an owned site the assistants cite gets reported back
 * as a third-party source to go pitch a link on.
 *
 * The split matters. A BRAND domain says "Kodus" on it, so a citation of one is
 * a citation of us. A PROPERTY is ours but deliberately unbranded — an editorial
 * site whose whole premise is that it isn't a vendor page. Counting a property
 * citation as a brand citation would quietly inflate the brand-cited metric and,
 * because past runs get re-analyzed, rewrite history too. So they stay separate:
 * both are excluded from outreach targets, only BRAND_DOMAINS mean "we were cited".
 */

/** Sites that carry the Kodus brand. Matched as substrings of a full URL, so a
 *  path is allowed here (the org on a shared host). */
export const BRAND_DOMAINS = [
  "kodus.io",
  "trykodus.com",
  "github.com/kodustech",
] as const;

/** Owned but unbranded editorial properties. Hostnames only. */
export const PROPERTY_DOMAINS = [
  "aicodereview.io",
  "aicodereviews.io",
  "codereviewbench.com",
] as const;

/** Hostnames of everything we own — what "don't treat this as someone else's
 *  site" should be keyed on. The brand list contributes hostnames only. */
export const OWNED_DOMAINS: string[] = [
  "kodus.io",
  "docs.kodus.io",
  "growth.kodus.io",
  "app.kodus.io",
  "trykodus.com",
  ...PROPERTY_DOMAINS,
];

/** True when a hostname is ours, including any subdomain of a domain we own. */
export function isOwnedDomain(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return OWNED_DOMAINS.some((own) => host === own || host.endsWith(`.${own}`));
}

/**
 * True when a URL points at a page of ours, including one that lives on a host
 * we don't own — the org on GitHub, say. A shared host can't be classified by
 * hostname: github.com carries our repos AND the awesome-lists we want to be
 * listed on, so the domain stays a legitimate outreach target while individual
 * pages of ours do not.
 */
export function isOwnedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isOwnedDomain(parsed.hostname)) return true;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const path = `${host}${parsed.pathname.toLowerCase().replace(/\/$/, "")}`;
  return BRAND_DOMAINS.some((own) => own.includes("/") && (path === own || path.startsWith(`${own}/`)));
}
