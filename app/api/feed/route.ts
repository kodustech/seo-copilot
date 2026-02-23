import { NextRequest, NextResponse } from "next/server";

import { fetchFeedPosts, parseFeedSource } from "@/lib/feed-sources";

export async function GET(request: NextRequest) {
  const source = parseFeedSource(request.nextUrl.searchParams.get("source"));

  try {
    const posts = await fetchFeedPosts(source);
    return NextResponse.json({ posts, source });
  } catch (error) {
    console.error("Error fetching feed posts", error);
    return NextResponse.json(
      { error: "Could not load feed posts right now." },
      { status: 500 },
    );
  }
}
