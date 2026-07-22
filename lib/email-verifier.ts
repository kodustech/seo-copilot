// Multi-provider email verification + domain probe.
//
// Primary: NeverBounce (NEVERBOUNCE_API_KEY)
// Secondary: ZeroBounce (ZEROBOUNCE_API_KEY) — when NB is unknown/missing
// Optional: Hunter verifier via lib/hunter (HUNTER_API_KEY)
//
// Docs:
//   NeverBounce — https://developers.neverbounce.com/v4.0/reference/single-check
//   ZeroBounce  — https://www.zerobounce.net/docs/email-validation-api-quickstart/
//
// Status semantics we store on research_people.email_status:
//   valid      — mailbox confirmed
//   catchall   — domain accepts anything (not person-proof)
//   invalid    — mailbox rejected
//   disposable — throwaway domain
//   unverified — we have an address but could not prove the inbox
//   bounced    — hard bounce from real send
//   unknown    — legacy; treat like unverified in UI
//   error      — verifier failure (do not treat as proof)
//
// Never persist config_missing — that is an infra issue, not a mailbox state.

export type VerificationStatus =
  | "valid"
  | "invalid"
  | "disposable"
  | "catchall"
  | "unknown"
  | "unverified"
  | "bounced"
  | "error"
  | "config_missing";

/** Statuses safe to show as "good enough" for cautious send. */
export function isSendReadyStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "valid";
}

/** Pattern guesses may only be saved when status is strictly valid. */
export function isPatternAcceptable(status: string | null | undefined): boolean {
  return (status ?? "").toLowerCase() === "valid";
}

/** Map NeverBounce / internal statuses into what we store on contacts. */
export function toStoredEmailStatus(
  status: VerificationStatus | string | null | undefined,
): string | null {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (s === "config_missing" || s === "error") return null;
  if (s === "unknown") return "unverified";
  if (
    s === "valid" ||
    s === "invalid" ||
    s === "disposable" ||
    s === "catchall" ||
    s === "unverified" ||
    s === "bounced"
  ) {
    return s;
  }
  return "unverified";
}

export type EmailVerificationResult = {
  email: string;
  status: VerificationStatus;
  flags: string[];
  suggestedCorrection: string | null;
  error: string | null;
};

export type DomainEmailProbe = {
  domain: string;
  /** probeable = random@domain is invalid → we can trust valid hits */
  kind: "probeable" | "catchall" | "unprobeable" | "config_missing";
  sampleStatus: VerificationStatus | null;
  sampleFlags: string[];
};

const NEVERBOUNCE_API = "https://api.neverbounce.com/v4/single/check";

const VALID_RESULTS = new Set<string>([
  "valid",
  "invalid",
  "disposable",
  "catchall",
  "unknown",
]);

const domainProbeCache = new Map<
  string,
  { at: number; value: DomainEmailProbe }
>();
const DOMAIN_PROBE_TTL_MS = 1000 * 60 * 60 * 6; // 6h process cache

export async function verifyEmail(
  email: string,
): Promise<EmailVerificationResult> {
  const apiKey = process.env.NEVERBOUNCE_API_KEY?.trim();
  if (!apiKey) {
    return {
      email,
      status: "config_missing",
      flags: [],
      suggestedCorrection: null,
      error:
        "NEVERBOUNCE_API_KEY not set — add it to Railway env vars to enable verification",
    };
  }

  try {
    const params = new URLSearchParams({
      key: apiKey,
      email,
      timeout: "15",
    });
    const res = await fetch(`${NEVERBOUNCE_API}?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    });

    if (!res.ok) {
      return {
        email,
        status: "error",
        flags: [],
        suggestedCorrection: null,
        error: `NeverBounce HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      status?: string;
      message?: string;
      result?: string;
      flags?: string[];
      suggested_correction?: string;
    };

    if (data.status !== "success") {
      return {
        email,
        status: "error",
        flags: [],
        suggestedCorrection: null,
        error: data.message ?? `Unexpected status: ${data.status ?? "n/a"}`,
      };
    }

    const result = data.result ?? "unknown";
    return {
      email,
      status: VALID_RESULTS.has(result)
        ? (result as VerificationStatus)
        : "unknown",
      flags: data.flags ?? [],
      suggestedCorrection: data.suggested_correction || null,
      error: null,
    };
  } catch (err) {
    return {
      email,
      status: "error",
      flags: [],
      suggestedCorrection: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifyEmails(
  emails: string[],
): Promise<EmailVerificationResult[]> {
  return Promise.all(emails.map(verifyEmail));
}

export function zeroBounceEnabled(): boolean {
  return Boolean(process.env.ZEROBOUNCE_API_KEY?.trim());
}

/** Map ZeroBounce status → our VerificationStatus. */
function mapZeroBounceStatus(
  status: string,
  subStatus?: string | null,
): VerificationStatus {
  const s = status.toLowerCase().replace(/_/g, "-");
  if (s === "valid") return "valid";
  if (s === "invalid") return "invalid";
  if (s === "catch-all" || s === "catchall") return "catchall";
  if (s === "do-not-mail" || s === "spamtrap" || s === "abuse") {
    if (subStatus?.toLowerCase() === "disposable") return "disposable";
    return "invalid";
  }
  if (s === "unknown") return "unknown";
  return "unknown";
}

/**
 * ZeroBounce single validate.
 * GET https://api.zerobounce.net/v2/validate
 * Does not charge credits for unknown results (per ZB docs).
 */
export async function verifyEmailZeroBounce(
  email: string,
): Promise<EmailVerificationResult> {
  const apiKey = process.env.ZEROBOUNCE_API_KEY?.trim();
  if (!apiKey) {
    return {
      email,
      status: "config_missing",
      flags: [],
      suggestedCorrection: null,
      error: "ZEROBOUNCE_API_KEY not set",
    };
  }

  try {
    const url = new URL("https://api.zerobounce.net/v2/validate");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("email", email.trim());
    url.searchParams.set("ip_address", "");
    url.searchParams.set("timeout", "20");

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      return {
        email,
        status: "error",
        flags: [],
        suggestedCorrection: null,
        error: `ZeroBounce HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      address?: string;
      status?: string;
      sub_status?: string;
      did_you_mean?: string | null;
      free_email?: boolean;
      catchall_domain?: boolean | null;
      mx_found?: string | boolean;
      error?: string;
      active_in_days?: string | null;
    };

    if (data.error) {
      return {
        email,
        status: "error",
        flags: [],
        suggestedCorrection: null,
        error: data.error,
      };
    }

    const status = mapZeroBounceStatus(
      data.status ?? "unknown",
      data.sub_status,
    );
    const flags: string[] = ["provider:zerobounce"];
    if (data.sub_status) flags.push(`sub:${data.sub_status}`);
    if (data.free_email) flags.push("free_email");
    if (data.catchall_domain) flags.push("catchall_domain");
    if (data.active_in_days) flags.push(`active_in_days:${data.active_in_days}`);

    return {
      email: data.address ?? email,
      status,
      flags,
      suggestedCorrection: data.did_you_mean ?? null,
      error: null,
    };
  } catch (err) {
    return {
      email,
      status: "error",
      flags: [],
      suggestedCorrection: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const STATUS_RANK: Record<string, number> = {
  valid: 5,
  catchall: 3,
  unverified: 2,
  unknown: 2,
  disposable: 1,
  invalid: 1,
  bounced: 1,
  error: 0,
  config_missing: 0,
};

/**
 * Waterfall verify: NeverBounce → ZeroBounce → Hunter verifier.
 * Picks the strongest conclusive status (valid > catchall > unknown > invalid).
 * Prefer a decisive invalid/valid over unknown when sources disagree.
 */
export async function verifyEmailMulti(
  email: string,
): Promise<EmailVerificationResult & { providers: string[] }> {
  const providers: string[] = [];
  const results: EmailVerificationResult[] = [];

  const nb = await verifyEmail(email);
  if (nb.status !== "config_missing") {
    providers.push("neverbounce");
    results.push({ ...nb, flags: [...nb.flags, "provider:neverbounce"] });
  }

  // ZeroBounce when NB unknown/error/missing — or always as second opinion if configured
  const needZb =
    zeroBounceEnabled() &&
    (nb.status === "config_missing" ||
      nb.status === "unknown" ||
      nb.status === "error" ||
      nb.status === "catchall");
  if (needZb) {
    const zb = await verifyEmailZeroBounce(email);
    if (zb.status !== "config_missing") {
      providers.push("zerobounce");
      results.push(zb);
    }
  }

  // Hunter verifier as last resort when still unknown and key present
  if (
    process.env.HUNTER_API_KEY?.trim() &&
    (results.length === 0 ||
      results.every((r) => r.status === "unknown" || r.status === "error"))
  ) {
    try {
      const { hunterVerifyEmail } = await import("@/lib/hunter");
      const hv = await hunterVerifyEmail(email);
      if (hv) {
        providers.push("hunter");
        const mapped: VerificationStatus =
          hv.status === "valid"
            ? "valid"
            : hv.status === "invalid"
              ? "invalid"
              : hv.status === "accept_all"
                ? "catchall"
                : hv.status === "disposable"
                  ? "disposable"
                  : "unknown";
        results.push({
          email,
          status: mapped,
          flags: [
            "provider:hunter",
            hv.acceptAll ? "accept_all" : "",
            hv.score != null ? `score:${hv.score}` : "",
          ].filter(Boolean),
          suggestedCorrection: null,
          error: null,
        });
      }
    } catch {
      // ignore
    }
  }

  if (results.length === 0) {
    return {
      email,
      status: "config_missing",
      flags: [],
      suggestedCorrection: null,
      error: "No email verifiers configured",
      providers,
    };
  }

  // Prefer valid if any provider says valid
  const validHit = results.find((r) => r.status === "valid");
  if (validHit) {
    return { ...validHit, providers };
  }
  // Prefer invalid if any says invalid (don't send)
  const invalidHit = results.find(
    (r) => r.status === "invalid" || r.status === "disposable",
  );
  if (invalidHit) {
    return { ...invalidHit, providers };
  }

  // Else highest rank
  let best = results[0];
  for (const r of results.slice(1)) {
    if ((STATUS_RANK[r.status] ?? 0) > (STATUS_RANK[best.status] ?? 0)) {
      best = r;
    }
  }
  return { ...best, providers };
}

export async function verifyEmailsMulti(
  emails: string[],
): Promise<Array<EmailVerificationResult & { providers: string[] }>> {
  // sequential-ish batches of 3 to avoid hammering free tiers
  const out: Array<EmailVerificationResult & { providers: string[] }> = [];
  for (let i = 0; i < emails.length; i += 3) {
    const batch = emails.slice(i, i + 3);
    const part = await Promise.all(batch.map((e) => verifyEmailMulti(e)));
    out.push(...part);
  }
  return out;
}

/**
 * Probe whether we can trust mailbox-level results on this domain.
 * Sends a random local-part — if NB says invalid, domain is probeable;
 * if valid/catchall, domain is catchall; if unknown, unprobeable (common .br).
 */
export async function probeDomainEmailability(
  domain: string,
): Promise<DomainEmailProbe> {
  const clean = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  const cached = domainProbeCache.get(clean);
  if (cached && Date.now() - cached.at < DOMAIN_PROBE_TTL_MS) {
    return cached.value;
  }

  const randomLocal = `nb-probe-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  const sample = `${randomLocal}@${clean}`;
  const v = await verifyEmail(sample);

  let kind: DomainEmailProbe["kind"];
  if (v.status === "config_missing") kind = "config_missing";
  else if (v.status === "invalid") kind = "probeable";
  else if (v.status === "valid" || v.status === "catchall") kind = "catchall";
  else kind = "unprobeable"; // unknown / error / disposable on random

  const value: DomainEmailProbe = {
    domain: clean,
    kind,
    sampleStatus: v.status,
    sampleFlags: v.flags,
  };
  domainProbeCache.set(clean, { at: Date.now(), value });
  return value;
}

/** SMTP / provider errors that usually mean hard bounce (permanent). */
export function looksLikeHardBounce(message: string | null | undefined): boolean {
  if (!message) return false;
  return /550|551|552|553|5\.1\.1|5\.1\.2|user unknown|mailbox (not found|unavailable)|does not exist|no such user|recipient rejected|address rejected|unknown user|invalid recipient|undeliverable/i.test(
    message,
  );
}
