import { NextResponse } from "next/server";

import {
  generateAndStoreDraftsForUser,
  syncAllUsersCandidates,
} from "@/lib/reply-radar";

export const maxDuration = 300;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const syncResults = await syncAllUsersCandidates();

    const draftSummaries = await Promise.all(
      syncResults
        .filter((result) => result.totalInserted > 0)
        .map(async (result) => {
          const drafts = await generateAndStoreDraftsForUser(result.userEmail);
          return { userEmail: result.userEmail, ...drafts };
        }),
    );

    return NextResponse.json({
      sync: syncResults,
      drafts: draftSummaries,
    });
  } catch (err) {
    console.error("[cron/reply-radar] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
