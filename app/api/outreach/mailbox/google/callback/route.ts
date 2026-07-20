import { NextResponse } from "next/server";

import {
  exchangeCodeForTokens,
  getAppBaseUrl,
  parseOAuthState,
} from "@/lib/outreach/google-oauth";
import { upsertMailboxFromGoogleOAuth } from "@/lib/outreach/mailbox";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

/**
 * Google redirects here after consent.
 * Saves mailbox and sends user back to /settings?mailbox=connected
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const base = getAppBaseUrl(req);

  if (oauthError) {
    return NextResponse.redirect(
      `${base}/settings?mailbox=error&reason=${encodeURIComponent(oauthError)}`,
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${base}/settings?mailbox=error&reason=${encodeURIComponent("missing_code")}`,
    );
  }

  try {
    const parsed = parseOAuthState(state);
    const tokens = await exchangeCodeForTokens(code, req);
    const client = getSupabaseServiceClient();
    await upsertMailboxFromGoogleOAuth(client, {
      email: tokens.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      fromName: parsed.fromName ?? null,
      label: parsed.label,
      dailyCap: parsed.dailyCap,
      createdByEmail: parsed.userEmail,
    });
    return NextResponse.redirect(
      `${base}/settings?mailbox=connected&email=${encodeURIComponent(tokens.email)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "oauth_failed";
    return NextResponse.redirect(
      `${base}/settings?mailbox=error&reason=${encodeURIComponent(msg)}`,
    );
  }
}
