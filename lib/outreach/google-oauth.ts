import { createHmac, timingSafeEqual } from "crypto";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
].join(" ");

function requireOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (Google Cloud Console → OAuth client).",
    );
  }
  return { clientId, clientSecret };
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(),
  );
}

export function getAppBaseUrl(req?: Request): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (fromEnv) {
    const base = fromEnv.startsWith("http")
      ? fromEnv
      : `https://${fromEnv}`;
    return base.replace(/\/$/, "");
  }
  if (req) {
    const host =
      req.headers.get("x-forwarded-host") || req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") || "https";
    if (host) return `${proto}://${host}`;
  }
  return "http://localhost:3737";
}

export function getGoogleOAuthRedirectUri(req?: Request): string {
  return `${getAppBaseUrl(req)}/api/outreach/mailbox/google/callback`;
}

function stateSecret(): string {
  return (
    process.env.OUTREACH_SECRETS_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ||
    "dev-state"
  );
}

/** Signed state so callback can trust user email. */
export function createOAuthState(payload: {
  userEmail: string;
  fromName?: string;
  dailyCap?: number;
  label?: string;
}): string {
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      ts: Date.now(),
    }),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function parseOAuthState(state: string): {
  userEmail: string;
  fromName?: string;
  dailyCap?: number;
  label?: string;
  ts: number;
} {
  const [body, sig] = state.split(".");
  if (!body || !sig) throw new Error("Invalid OAuth state");
  const expected = createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid OAuth state signature");
  }
  const parsed = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as {
    userEmail: string;
    fromName?: string;
    dailyCap?: number;
    label?: string;
    ts: number;
  };
  if (!parsed.userEmail) throw new Error("OAuth state missing user");
  // 30 min
  if (Date.now() - parsed.ts > 30 * 60 * 1000) {
    throw new Error("OAuth state expired — try Connect again");
  }
  return parsed;
}

export function buildGoogleAuthUrl(opts: {
  state: string;
  req?: Request;
}): string {
  const { clientId } = requireOAuthConfig();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getGoogleOAuthRedirectUri(opts.req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  email: string;
};

export async function exchangeCodeForTokens(
  code: string,
  req?: Request,
): Promise<GoogleTokenSet> {
  const { clientId, clientSecret } = requireOAuthConfig();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getGoogleOAuthRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "Token exchange failed",
    );
  }

  const email = await fetchGoogleEmail(data.access_token);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    email,
  };
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = (await res.json()) as { email?: string; error?: { message?: string } };
  if (!res.ok || !data.email) {
    throw new Error(data.error?.message || "Could not read Google account email");
  }
  return data.email.toLowerCase();
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const { clientId, clientSecret } = requireOAuthConfig();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "Token refresh failed",
    );
  }
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  };
}

export function encryptToken(token: string): string {
  return encryptSecret(token);
}

export function decryptToken(payload: string): string {
  return decryptSecret(payload);
}

/** RFC 2822 raw message → Gmail API base64url */
export function buildRawGmailMessage(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}): string {
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(opts.subject || "(no subject)", "utf8").toString("base64")}?=`;
  const boundary = `kodus_${Date.now().toString(36)}`;
  let raw: string;
  if (opts.html) {
    raw = [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${subjectEncoded}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      opts.text,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "",
      opts.html,
      "",
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    raw = [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${subjectEncoded}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      opts.text,
    ].join("\r\n");
  }
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendViaGmailApi(opts: {
  accessToken: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}): Promise<{ messageId: string }> {
  const raw = buildRawGmailMessage(opts);
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );
  const data = (await res.json()) as {
    id?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(data.error?.message || `Gmail API ${res.status}`);
  }
  return { messageId: data.id ?? "" };
}
