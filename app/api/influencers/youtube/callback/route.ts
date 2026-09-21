import { NextResponse } from "next/server";

import { setChannelCredential } from "@/lib/influencer/credentials";
import { getChannel, updateChannel } from "@/lib/influencer/personas";
import { exchangeYoutubeCode, parseYoutubeOAuthState, youtubeChannelNeeds } from "@/lib/influencer/youtube-oauth";
import { getAppBaseUrl } from "@/lib/outreach/google-oauth";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

/**
 * Google redirects here after consent. The signed state names the channel and
 * the person who pressed Connect; the refresh token goes to the vault and the
 * browser returns to the influencers page.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (status: string, reason?: string) =>
    NextResponse.redirect(
      `${getAppBaseUrl(req)}/influencers?youtube=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`,
    );
  const oauthError = url.searchParams.get("error");
  if (oauthError) return back("error", oauthError);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back("error", "missing_code");

  try {
    const parsed = parseYoutubeOAuthState(state);
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
