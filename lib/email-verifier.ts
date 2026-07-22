// NeverBounce email verifier + domain probe for honest outreach signals.
//
// Docs: https://developers.neverbounce.com/v4.0/reference/single-check
//
// Status semantics we store on research_people.email_status:
//   valid      — mailbox confirmed
//   catchall   — domain accepts anything (not person-proof)
//   invalid    — mailbox rejected
//   disposable — throwaway domain
//   unverified — we have an address but could not prove the inbox
//                (NB unknown, unprobeable BR MX, config issues after provider hit)
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
