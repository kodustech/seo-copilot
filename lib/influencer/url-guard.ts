/**
 * SSRF guard for model-chosen URLs. The model picks the URL for fetch_url and
 * browse, so a manipulated goal could aim it at cloud metadata
 * (169.254.169.254), localhost, or a private host. Require http(s), block known
 * hosts, and reject any host that resolves to a private/reserved address.
 *
 * Residual DNS-rebinding gap (accepted): we resolve + check the IPs, then return
 * the URL by hostname, so the actual fetch/browse re-resolves and could in theory
 * hit a rebound private IP. We accept this for these tools because (a) `browse`
 * runs on a REMOTE browser (Browserbase) that re-resolves off our network — we
 * can't pin an IP there anyway; (b) pinning the IP in `fetchText` would break TLS
 * SNI / cert validation; (c) both tools only READ public content back into the
 * model's context — no credentials are sent and no state changes — so a
 * successful rebind is a bounded info-read, not account/infra compromise; and
 * (d) it needs attacker-controlled DNS plus precise timing between resolve and
 * fetch. Pinned-IP fetching is a later hardening if the threat model changes.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isOwnedDomain } from "@/lib/owned-domains";

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);

/** Private / reserved / loopback / link-local address → not fetchable. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  // fc00::/7 unique-local covers fc00–fdff → first hextet starts with fc or fd.
  if (low.startsWith("fc") || low.startsWith("fd")) return true;
  // fe80::/10 link-local covers fe80–febf, not just fe80 — mask the top 10 bits.
  const firstHextet = parseInt(low.split(":")[0] || "0", 16);
  if (Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) return true;
  return false;
}

export async function assertPublicUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed.");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("That host is not allowed.");
  }
  const ips = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address);
  if (ips.some(isPrivateIp)) {
    throw new Error("URL resolves to a private or reserved address.");
  }
  return parsed;
}

/**
 * A canonical tag hands the ranking to whatever it points at, so a model-chosen
 * canonical may only ever point at a site we own — otherwise a crosspost credits
 * someone else's page for our own writing. Not an SSRF check: nothing fetches
 * this URL, it is written into the published article.
 */
export function isOwnedCanonical(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isOwnedDomain(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Trailing slashes differ between what an API returns and what a model copies
 * back, and that isn't a different page. Case is only forgiving where the spec
 * says it is: scheme and host are case-insensitive, the path is not. Folding
 * the path too would accept /blog/DevOps-Guide for /blog/devops-guide and send
 * the ranking to a 404 on any case-sensitive host.
 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    // `host`, not `hostname`: the latter drops the port, so a canonical on
    // :8443 would compare equal to the real page on the default port and the
    // tag would be written pointing at a different origin.
    const host = url.host.toLowerCase().replace(/\.$/, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${host}${path}${url.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * A canonical must be a page the persona actually published, not merely a page
 * on a domain we own. Owning the domain closes the competitor case; it does
 * nothing about an invented URL, and a canonical pointing at a page that was
 * never written hands the ranking to a 404. The shift prompt hands the persona
 * its own live URLs precisely so it doesn't have to remember one.
 */
export function matchesOwnOriginal(canonical: string, publishedUrls: string[]): boolean {
  const target = normalizeUrl(canonical);
  if (!target) return false;
  return publishedUrls.some((url) => normalizeUrl(url) === target);
}
