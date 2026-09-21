/**
 * "Connect with Google" for a persona's YouTube channel: consent in the
 * browser, refresh token straight into the vault. Same shape as the mailbox
 * OAuth (lib/outreach/google-oauth.ts), with its own redirect, a state that
 * names the channel so the callback can only ever write to that one, and a
 * nonce that ties the flow to the browser that started it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getChannelCredentialCipher } from "@/lib/influencer/credentials";
import { fleetHeyGenKey } from "@/lib/influencer/heygen";
import type { PersonaChannel } from "@/lib/influencer/types";
import { youtubeChannelConfig } from "@/lib/influencer/youtube";
import { getAppBaseUrl } from "@/lib/outreach/google-oauth";

const YOUTUBE_OAUTH_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"].join(" ");
const STATE_TTL_MS = 30 * 60 * 1000;

/**
 * The YouTube client falls back to the app's Google OAuth client: one Google
 * Cloud project with the YouTube Data API enabled is enough.
 */
export function youtubeOAuthClient(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_YOUTUBE_CLIENT_ID?.trim() || process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret =
    process.env.GOOGLE_YOUTUBE_CLIENT_SECRET?.trim() || process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "YouTube OAuth is not configured. Set GOOGLE_YOUTUBE_CLIENT_ID/SECRET (or GOOGLE_OAUTH_CLIENT_ID/SECRET) for a project with the YouTube Data API enabled.",
    );
  }
  return { clientId, clientSecret };
}

export function isYoutubeOAuthConfigured(): boolean {
  try {
    youtubeOAuthClient();
    return true;
  } catch {
    return false;
  }
}

export function getYoutubeOAuthRedirectUri(req?: Request): string {
  return `${getAppBaseUrl(req)}/api/influencers/youtube/callback`;
}

function stateSecret(): string {
  const secret =
    process.env.INFLUENCER_SECRETS_KEY?.trim() ||
    process.env.OUTREACH_SECRETS_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret) throw new Error("No server secret to sign the OAuth state with.");
  return secret;
}

/**
 * Also carried in an httpOnly cookie on the browser that pressed Connect. The
 * callback requires both to match, so a leaked callback URL is useless on any
 * other browser: without it, anyone holding the URL could finish the consent
 * with their own Google account and bind that channel to our persona.
 */
export const YOUTUBE_OAUTH_NONCE_COOKIE = "yt_oauth_nonce";
export const YOUTUBE_OAUTH_COOKIE_PATH = "/api/influencers/youtube/callback";

export type YoutubeOAuthState = { channelId: string; userEmail: string; nonce: string; ts: number };

export function createYoutubeOAuthState(
  payload: { channelId: string; userEmail: string; nonce: string },
  now = Date.now(),
): string {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: now }), "utf8").toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function parseYoutubeOAuthState(state: string, now = Date.now()): YoutubeOAuthState {
  const [body, sig] = state.split(".");
  if (!body || !sig) throw new Error("Invalid OAuth state");
  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid OAuth state signature");
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<YoutubeOAuthState>;
  if (!parsed.channelId || !parsed.userEmail || !parsed.nonce || typeof parsed.ts !== "number") {
    throw new Error("OAuth state is incomplete");
  }
  if (now - parsed.ts > STATE_TTL_MS) throw new Error("OAuth state expired, press Connect again");
  return parsed as YoutubeOAuthState;
}

/** The cookie half of the state check, compared in constant time. */
export function newOAuthNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function nonceMatches(stateNonce: string, cookieNonce: string | undefined): boolean {
  if (!cookieNonce) return false;
  const a = Buffer.from(stateNonce);
  const b = Buffer.from(cookieNonce);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildYoutubeAuthUrl(state: string, req?: Request): string {
  const { clientId } = youtubeOAuthClient();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getYoutubeOAuthRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_OAUTH_SCOPES);
  // offline + consent: Google only returns a refresh token on a fresh consent.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeYoutubeCode(code: string, req?: Request): Promise<string> {
  const { clientId, clientSecret } = youtubeOAuthClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getYoutubeOAuthRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok) throw new Error(data.error_description || data.error || `Token exchange HTTP ${res.status}`);
  if (!data.refresh_token) {
    throw new Error("Google returned no refresh token. Remove the app's access in your Google account and connect again.");
  }
  return data.refresh_token;
}

/**
 * What still stands between this channel and rendering. Shared by the manual
 * connect form and the OAuth callback, so both activate on the same rule.
 */
export async function youtubeChannelNeeds(
  client: SupabaseClient,
  channel: PersonaChannel,
  oauthLinked: boolean,
): Promise<{ oauth: boolean; heygen: boolean; avatar: boolean; voice: boolean }> {
  const heygen = Boolean(fleetHeyGenKey()) || Boolean(await getChannelCredentialCipher(client, channel.persona_id, "heygen"));
  const cfg = youtubeChannelConfig(channel);
  return { oauth: !oauthLinked, heygen: !heygen, avatar: !cfg.avatarId, voice: !cfg.voiceId };
}
