import { NextResponse } from "next/server";

import {
  buildGoogleAuthUrl,
  createOAuthState,
  isGoogleOAuthConfigured,
} from "@/lib/outreach/google-oauth";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * POST { fromName?, dailyCap?, label? }
 * → { url } Google consent screen
 */
export async function POST(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    if (!isGoogleOAuthConfigured()) {
      return NextResponse.json(
        {
          error:
            "Google OAuth not configured on the server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
        },
        { status: 503 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const state = createOAuthState({
      userEmail,
      fromName:
        typeof body.fromName === "string" ? body.fromName : undefined,
      dailyCap:
        body.dailyCap != null ? Number(body.dailyCap) : undefined,
      label: typeof body.label === "string" ? body.label : undefined,
    });

    const url = buildGoogleAuthUrl({ state, req });
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

/** GET — convenience redirect when browser navigates with session cookie not available; use POST from UI. */
export async function GET() {
  return NextResponse.json(
    { error: "Use POST from Settings with Authorization header" },
    { status: 405 },
  );
}
