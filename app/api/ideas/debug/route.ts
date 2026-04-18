import { NextResponse } from "next/server";

import { searchWebContent } from "@/lib/exa";
import { fetchFeedPosts } from "@/lib/feed-sources";
import { getSupabaseServiceClient, getSupabaseUserClient } from "@/lib/supabase-server";
import { getCompetitorDomains } from "@/lib/voice-policy";

export const maxDuration = 120;

// Diagnostics endpoint. Authenticated user (any logged-in admin) can hit this
// to see exactly what each source is returning so we can tell whether the
// problem is misconfigured domains, an empty Exa response, or a missing key.
export async function GET(request: Request) {
  try {
    await getSupabaseUserClient(request.headers.get("authorization"));

    const domains = await getCompetitorDomains(getSupabaseServiceClient());
    const hasExaKey = Boolean(process.env.EXA_API_KEY?.trim());

    const [competitor, reddit, hn, sampleStrict, sampleBroad] = await Promise.allSettled([
      fetchFeedPosts("competitor"),
      fetchFeedPosts("reddit"),
      fetchFeedPosts("hackernews"),
      domains.length
        ? searchWebContent({
            query: "AI code review automation",
            domains,
            numResults: 5,
            daysBack: 120,
            textMaxCharacters: 200,
          })
        : Promise.resolve({ query: "(no domains configured)", results: [] }),
      searchWebContent({
        query: "AI code review automation",
        excludeDomains: ["kodus.io"],
        numResults: 5,
        daysBack: 120,
        textMaxCharacters: 200,
      }),
    ]);

    return NextResponse.json({
      env: {
        hasExaKey,
        hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
        hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
        hasGoogleKey: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()),
        aiProvider: process.env.AI_PROVIDER || "(unset, defaults to google)",
      },
      configuredDomains: domains,
      feedCounts: {
        competitor:
          competitor.status === "fulfilled" ? competitor.value.length : null,
        reddit: reddit.status === "fulfilled" ? reddit.value.length : null,
        hackernews: hn.status === "fulfilled" ? hn.value.length : null,
      },
      feedErrors: {
        competitor:
          competitor.status === "rejected" ? String(competitor.reason) : null,
        reddit: reddit.status === "rejected" ? String(reddit.reason) : null,
        hackernews: hn.status === "rejected" ? String(hn.reason) : null,
      },
      sampleCompetitor:
        competitor.status === "fulfilled"
          ? competitor.value
              .slice(0, 5)
              .map((item) => ({ title: item.title, link: item.link }))
          : [],
      sampleReddit:
        reddit.status === "fulfilled"
          ? reddit.value
              .slice(0, 5)
              .map((item) => ({ title: item.title, link: item.link }))
          : [],
      sampleHn:
        hn.status === "fulfilled"
          ? hn.value
              .slice(0, 5)
              .map((item) => ({ title: item.title, link: item.link }))
          : [],
      exaStrictProbe: {
        query: "AI code review automation",
        domains,
        status: sampleStrict.status,
        resultCount:
          sampleStrict.status === "fulfilled"
            ? sampleStrict.value.results.length
            : null,
        sample:
          sampleStrict.status === "fulfilled"
            ? sampleStrict.value.results.slice(0, 5).map((r) => ({
                title: r.title,
                url: r.url,
              }))
            : null,
        error:
          sampleStrict.status === "rejected"
            ? String(sampleStrict.reason)
            : null,
      },
      exaBroadProbe: {
        query: "AI code review automation",
        excludeDomains: ["kodus.io"],
        status: sampleBroad.status,
        resultCount:
          sampleBroad.status === "fulfilled"
            ? sampleBroad.value.results.length
            : null,
        sample:
          sampleBroad.status === "fulfilled"
            ? sampleBroad.value.results.slice(0, 5).map((r) => ({
                title: r.title,
                url: r.url,
              }))
            : null,
        error:
          sampleBroad.status === "rejected"
            ? String(sampleBroad.reason)
            : null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
