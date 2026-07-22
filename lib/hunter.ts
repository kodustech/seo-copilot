/**
 * Hunter.io API helpers — email finder + verifier.
 * Docs: https://hunter.io/api-documentation/v2
 *
 * Gated on HUNTER_API_KEY. Soft-fail callers should treat null as miss.
 */

export function hunterEnabled(): boolean {
  return Boolean(process.env.HUNTER_API_KEY?.trim());
}

export type HunterEmailFinderResult = {
  email: string;
  score: number; // 0–100 Hunter confidence
  sources: number;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  verificationStatus: string | null; // valid | accept_all | unknown | null
};

export type HunterVerifyResult = {
  email: string;
  status: "valid" | "invalid" | "accept_all" | "webmail" | "disposable" | "unknown";
  score: number | null;
  regexp: boolean | null;
  gibberish: boolean | null;
  mxRecords: boolean | null;
  smtpServer: boolean | null;
  smtpCheck: boolean | null;
  acceptAll: boolean | null;
  block: boolean | null;
};

/**
 * Most likely personal email for first + last @ domain.
 * GET /v2/email-finder
 */
export async function hunterEmailFinder(input: {
  domain: string;
  firstName: string;
  lastName?: string | null;
  fullName?: string | null;
}): Promise<HunterEmailFinderResult | null> {
  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key) return null;

  const domain = input.domain
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase();
  if (!domain || !input.firstName?.trim()) return null;

  const url = new URL("https://api.hunter.io/v2/email-finder");
  url.searchParams.set("domain", domain);
  url.searchParams.set("first_name", input.firstName.trim());
  if (input.lastName?.trim()) {
    url.searchParams.set("last_name", input.lastName.trim());
  }
  if (input.fullName?.trim()) {
    url.searchParams.set("full_name", input.fullName.trim());
  }
  url.searchParams.set("api_key", key);

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[hunter] email-finder HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: {
        email?: string | null;
        score?: number;
        sources?: unknown[];
        first_name?: string | null;
        last_name?: string | null;
        position?: string | null;
        verification?: { status?: string | null } | null;
      };
    };
    const email = json.data?.email?.trim();
    if (!email) return null;
    return {
      email,
      score: typeof json.data?.score === "number" ? json.data.score : 0,
      sources: Array.isArray(json.data?.sources) ? json.data.sources.length : 0,
      firstName: json.data?.first_name ?? null,
      lastName: json.data?.last_name ?? null,
      position: json.data?.position ?? null,
      verificationStatus: json.data?.verification?.status ?? null,
    };
  } catch (err) {
    console.warn("[hunter] email-finder failed:", err);
    return null;
  }
}

/**
 * Hunter email verifier (optional second opinion / when NB missing).
 * GET /v2/email-verifier
 */
export async function hunterVerifyEmail(
  email: string,
): Promise<HunterVerifyResult | null> {
  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key || !email.includes("@")) return null;

  const url = new URL("https://api.hunter.io/v2/email-verifier");
  url.searchParams.set("email", email.trim());
  url.searchParams.set("api_key", key);

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[hunter] email-verifier HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: {
        email?: string;
        status?: string;
        score?: number;
        regexp?: boolean;
        gibberish?: boolean;
        mx_records?: boolean;
        smtp_server?: boolean;
        smtp_check?: boolean;
        accept_all?: boolean;
        block?: boolean;
      };
    };
    const d = json.data;
    if (!d?.status) return null;
    const status = d.status as HunterVerifyResult["status"];
    return {
      email: d.email ?? email,
      status,
      score: d.score ?? null,
      regexp: d.regexp ?? null,
      gibberish: d.gibberish ?? null,
      mxRecords: d.mx_records ?? null,
      smtpServer: d.smtp_server ?? null,
      smtpCheck: d.smtp_check ?? null,
      acceptAll: d.accept_all ?? null,
      block: d.block ?? null,
    };
  } catch (err) {
    console.warn("[hunter] email-verifier failed:", err);
    return null;
  }
}
