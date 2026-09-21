import { NextResponse } from "next/server";

import { getChannel } from "@/lib/influencer/personas";
import {
  buildYoutubeAuthUrl,
  createYoutubeOAuthState,
  isYoutubeOAuthConfigured,
} from "@/lib/influencer/youtube-oauth";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * POST → { url }: the Google consent screen for this channel. The UI calls it
 * with the user's bearer token and navigates to the URL; Google sends the
 * browser back to /api/influencers/youtube/callback.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let userEmail: string;
  let client;
  try {
    ({ client, userEmail } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isYoutubeOAuthConfigured()) {
    return NextResponse.json(
      { error: "YouTube OAuth is not configured on the server (GOOGLE_YOUTUBE_CLIENT_ID/SECRET)." },
      { status: 503 },
    );
  }
  const { id } = await ctx.params;
  // Read through the user's client: a channel they cannot see never gets a state.
  const channel = await getChannel(client, id).catch(() => null);
  if (!channel || channel.platform !== "youtube") {
    return NextResponse.json({ error: "YouTube channel not found." }, { status: 404 });
  }
  const state = createYoutubeOAuthState({ channelId: channel.id, userEmail });
  return NextResponse.json({ url: buildYoutubeAuthUrl(state, req) });
}
