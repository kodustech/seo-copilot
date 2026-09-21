import { NextResponse, type NextRequest } from "next/server";

import { setChannelCredential } from "@/lib/influencer/credentials";
import { getChannel, updateChannel } from "@/lib/influencer/personas";
import {
  exchangeYoutubeCode,
  nonceMatches,
  parseYoutubeOAuthState,
  youtubeChannelNeeds,
  YOUTUBE_OAUTH_COOKIE_PATH,
  YOUTUBE_OAUTH_NONCE_COOKIE,
} from "@/lib/influencer/youtube-oauth";
import { getAppBaseUrl } from "@/lib/outreach/google-oauth";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

/**
 * Google redirects here after consent. The signed state names the channel and
 * the person who pressed Connect, and its nonce must match the cookie the
 * start route left on this browser, so the URL alone cannot finish the flow.
 * Every signed-in user may manage every persona (the tables' RLS is
 * authenticated-all), so the state's signer is the authorization. The refresh
 * token goes to the vault and the browser returns to the influencers page.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const back = (status: string, reason?: string) => {
    const res = NextResponse.redirect(
      `${getAppBaseUrl(req)}/influencers?youtube=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`,
    );
    // Single use: success or failure, this flow's nonce is spent.
    res.cookies.set(YOUTUBE_OAUTH_NONCE_COOKIE, "", { path: YOUTUBE_OAUTH_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  const oauthError = url.searchParams.get("error");
  if (oauthError) return back("error", oauthError);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back("error", "missing_code");

  try {
    const parsed = parseYoutubeOAuthState(state);
    if (!nonceMatches(parsed.nonce, req.cookies.get(YOUTUBE_OAUTH_NONCE_COOKIE)?.value)) {
      return back("error", "Finish the connection in the same browser that pressed Connect.");
    }
    const client = getSupabaseServiceClient();
    const channel = await getChannel(client, parsed.channelId);
    if (!channel || channel.platform !== "youtube") return back("error", "channel_not_found");
    const refreshToken = await exchangeYoutubeCode(code, req);
    await setChannelCredential(client, {
      persona_id: channel.persona_id,
      platform: "youtube",
      key: refreshToken,
      label: "youtube",
      created_by: parsed.userEmail,
    });
    const needs = await youtubeChannelNeeds(client, channel, true);
    await updateChannel(client, channel.id, {
      credentials_ref: "vault:youtube",
      status: needs.heygen || needs.avatar || needs.voice ? channel.status : "active",
    });
    return back("connected");
  } catch (err) {
    return back("error", err instanceof Error ? err.message : "oauth_failed");
  }
}
