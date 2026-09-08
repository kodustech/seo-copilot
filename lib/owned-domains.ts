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

/** Every property a bet can be measured against, as the picker offers them:
 *  the hosts we own plus the path-scoped ones on a shared host. */
export const OWNED_PROPERTIES: string[] = [
  ...OWNED_DOMAINS,
  ...BRAND_DOMAINS.filter((d) => d.includes("/")),
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

function normalizeProperty(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

function matchesOne(url: string, target: string): boolean {
  if (!target) return false;
  if (target === "any") return isOwnedUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!target.includes("/")) return host === target || host.endsWith(`.${target}`);
  const path = `${host}${parsed.pathname.toLowerCase().replace(/\/+$/, "")}`;
  return path === target || path.startsWith(`${target}/`);
}

/**
 * True when a URL points at one named property of ours — a host
 * ("aicodereview.io", subdomains included) or a host and path prefix
 * ("github.com/kodustech"). "any" matches every property we own.
 *
 * A property can be written as a comma-separated list, because a site is not
 * always a domain: the directory answers on aicodereview.io AND
 * aicodereviews.io, and the assistants cite whichever they found. Counting one
 * of them would read as half the presence the site actually has.
 *
 * This is what a bet on external presence asks: not "was some page of ours
 * cited" but "was THIS site cited", because each site is a separate test.
 */
export function urlMatchesProperty(url: string, property: string): boolean {
  const targets = property.split(",").map(normalizeProperty).filter(Boolean);
  return targets.some((t) => matchesOne(url, t));
}

/** True when a string names a property we own — the guard for a measure that
 *  claims to count citations of one. A typo would otherwise read as zero
 *  forever, which looks exactly like a hypothesis that did not work. */
export function isOwnedProperty(property: string): boolean {
  const targets = property.split(",").map(normalizeProperty).filter(Boolean);
  if (!targets.length) return false;
  return targets.every(
    (t) =>
      OWNED_DOMAINS.some((own) => t === own || t.endsWith(`.${own}`)) ||
      BRAND_DOMAINS.some((own) => own.includes("/") && (t === own || t.startsWith(`${own}/`))),
  );
}
