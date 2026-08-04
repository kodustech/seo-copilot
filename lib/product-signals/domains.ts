// ---------------------------------------------------------------------------
// Domain classification for product signups.
//
// The only job here is answering "does this email domain identify a company we
// could sell to?". Everything is a pure function over a domain string so the
// rules can be read and tested without touching BigQuery.
//
// Matching is by registrable-suffix, not equality. The previous exact-match Set
// blocked hotmail.com but let hotmail.co.jp, yandex.ru, zohomail.in and qq.com
// through, and each of those became a "company" in the CRM named after the mail
// provider.
// ---------------------------------------------------------------------------

/** Free/personal mail providers. Matched as the domain itself or a subdomain,
 *  plus country variants of the big providers (see FREE_MAIL_ROOTS). */
const FREE_MAIL_EXACT = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "tutanota.com",
  "tutamail.com",
  "mailfence.com",
  "fastmail.com",
  "hushmail.com",
  "aol.com",
  "mail.com",
  "email.com",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  "foxmail.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "rediffmail.com",
  "web.de",
  "t-online.de",
  "orange.fr",
  "free.fr",
  "libero.it",
  "seznam.cz",
  "wp.pl",
  "o2.pl",
  "onet.pl",
  "interia.pl",
  "abv.bg",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "globo.com",
  "r7.com",
  "zipmail.com.br",
  "superig.com.br",
  // Privacy relays and forwarders: never a company.
  "privaterelay.appleid.com",
  "duck.com",
  "simplelogin.com",
  "anonaddy.com",
  "relay.firefox.com",
  // Code hosts: shows up via noreply addresses.
  "github.com",
  "users.noreply.github.com",
  "gitlab.com",
  "bitbucket.org",
]);

/** Providers with many country/product variants. Any domain whose first label
 *  chain starts with one of these is personal mail: hotmail.co.jp, yahoo.co.uk,
 *  outlook.jp, yandex.ru, zohomail.in, live.com.au, gmx.net, mail.ru. */
const FREE_MAIL_ROOTS = [
  // gmail.com/googlemail.com are in FREE_MAIL_EXACT, but the country variants
  // (gmail.com.br, gmail.co.uk) need the root rule like every other provider —
  // leaving the largest provider out of it keeps the exact leak this fixes.
  "gmail",
  "googlemail",
  "hotmail",
  "outlook",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "rocketmail",
  "yandex",
  "zoho",
  "zohomail",
  "gmx",
  "inbox",
  "mail",
];

/** Academic institutions: students and faculty, never a sales target. */
const ACADEMIC_PATTERNS = [
  /(^|\.)edu$/,
  /(^|\.)edu\.[a-z]{2}$/,
  /(^|\.)ac\.[a-z]{2}$/,
  /(^|\.)edu\.[a-z]{2}\.[a-z]{2}$/,
  /(^|\.)sch\.[a-z]{2}$/,
  /(^|\.)uni-[a-z-]+\.[a-z]+$/,
  // Brazilian institutions mostly sit under plain .br, with no academic suffix
  // at all, so none of the patterns above see them. Federal and state
  // universities follow the uf*/une*/unif* naming convention; the rest are
  // named individually because a generic /uni[a-z]+\.br/ would also match
  // ordinary companies.
  /(^|\.)uf[a-z]{1,4}\.br$/, // ufal, ufmg, ufrj, ufscar…
  /(^|\.)une[a-z]{1,3}\.br$/, // unesp, unemat…
  /(^|\.)unif[a-z]{2,4}\.br$/, // unifesp, unifei…
  /(^|\.)(usp|unicamp|puc|puc-rio|pucrs|pucpr|ita|ime|insper|fgv|mackenzie)\.br$/,
  /(^|\.)(cefet|fatec|etec|senai|senac|sesi)[a-z-]*\./,
  /(^|\.)if[a-z]{2,4}\.(edu\.)?br$/, // ifsp, ifrs, ifmg, ifba…
  /(^|\.)edu\.br$/,
];

/** Our own domains and obvious test artifacts. */
const INTERNAL_PATTERNS = [
  /(^|\.)kodus\./,
  /(^|\.)kodus$/,
  /(^|\.)kodyai\./,
  /(^|\.)example\.(com|org|net)$/,
  /(^|\.)test$/,
  /(^|\.)local(host)?$/,
  /(^|\.)invalid$/,
];

export type DomainVerdict =
  | "corporate"
  | "free_mail"
  | "academic"
  | "internal"
  | "invalid";

function labels(domain: string): string[] {
  return domain.split(".").filter(Boolean);
}

export function isFreeMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  if (FREE_MAIL_EXACT.has(d)) return true;
  // Subdomain of a listed provider (mail.qq.com).
  for (const known of FREE_MAIL_EXACT) {
    if (d.endsWith(`.${known}`)) return true;
  }
  // Country/product variants: the first label is the provider brand and what
  // follows is a public suffix (yahoo.co.uk, outlook.jp, mail.ru).
  const parts = labels(d);
  if (parts.length >= 2 && FREE_MAIL_ROOTS.includes(parts[0])) {
    const rest = parts.slice(1);
    // Guard against legitimate companies that merely start with the brand
    // (mailchimp.com is one label; live.mycompany.com has a non-suffix tail).
    const suffixIsPublic = rest.every((p) => p.length <= 3) && rest.length <= 2;
    if (suffixIsPublic) return true;
  }
  return false;
}

export function isAcademicDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return ACADEMIC_PATTERNS.some((re) => re.test(d));
}

export function isInternalDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return INTERNAL_PATTERNS.some((re) => re.test(d));
}

/** Single entry point used by the collector and the sweep. */
export function classifyDomain(domain: string | null): DomainVerdict {
  const d = domain?.trim().toLowerCase() ?? "";
  if (!d || !d.includes(".") || d.includes(" ")) return "invalid";
  if (isInternalDomain(d)) return "internal";
  if (isFreeMailDomain(d)) return "free_mail";
  if (isAcademicDomain(d)) return "academic";
  return "corporate";
}

export function isCorporateDomain(domain: string | null): boolean {
  return classifyDomain(domain) === "corporate";
}
