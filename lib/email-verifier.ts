// NeverBounce email verifier — single-check endpoint per email. We use it to
// turn the guessed email patterns into a real signal (valid / invalid /
// catchall / etc.) before the team commits to a send.
//
// Docs: https://developers.neverbounce.com/v4.0/reference/single-check
//
// Cost model: 1 credit per email. The /api/outreach/verify-emails endpoint
// caps batches at 50 to prevent accidental burns. Per Gabriel: free tier
// granted ~1000 credits to start, so ~125 typical 8-pattern verifications.

export type VerificationStatus =
  | "valid"
  | "invalid"
  | "disposable"
  | "catchall"
  | "unknown"
  | "error"
  | "config_missing";

export type EmailVerificationResult = {
  email: string;
  status: VerificationStatus;
  flags: string[];
  suggestedCorrection: string | null;
  error: string | null;
};

const NEVERBOUNCE_API = "https://api.neverbounce.com/v4/single/check";

const VALID_RESULTS = new Set<string>([
  "valid",
  "invalid",
  "disposable",
  "catchall",
  "unknown",
]);

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
      // Skip optional add-ons to keep response cheap; we only need result.
      timeout: "10",
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

    // NeverBounce wraps real results in { status: "success", result: ... }.
    // Anything other than "success" at the envelope level is an API error.
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

// Verify several emails in parallel. NeverBounce has a generous rate limit
// for single-check (10 req/sec on free, higher on paid), so 8 in parallel
// is well under the cap.
export async function verifyEmails(
  emails: string[],
): Promise<EmailVerificationResult[]> {
  return Promise.all(emails.map(verifyEmail));
}
