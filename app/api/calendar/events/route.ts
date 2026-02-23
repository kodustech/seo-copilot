import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  buildJobEventsForRange,
  buildPublishedPostEventsForRange,
  buildScheduledSocialEventsForRange,
  parseMonthKey,
  sortCalendarEvents,
  type CalendarEvent,
} from "@/lib/calendar";

export async function GET(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const { searchParams } = new URL(req.url);
    const { monthKey, start, end } = parseMonthKey(searchParams.get("month"));

    const [jobsResult, postsResult, scheduledSocialResult] =
      await Promise.allSettled([
      buildJobEventsForRange(client, userEmail, { start, end }),
      buildPublishedPostEventsForRange({ start, end }),
      buildScheduledSocialEventsForRange({ start, end }),
    ]);
    const jobEvents = jobsResult.status === "fulfilled" ? jobsResult.value : [];
    const postEvents = postsResult.status === "fulfilled" ? postsResult.value : [];
    const scheduledSocialEvents =
      scheduledSocialResult.status === "fulfilled"
        ? scheduledSocialResult.value
        : [];

    const events: CalendarEvent[] = sortCalendarEvents([
      ...jobEvents,
      ...postEvents,
      ...scheduledSocialEvents,
    ]);

    return NextResponse.json({
      month: monthKey,
      range: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      events,
      counts: {
        jobs: jobEvents.length,
        posts: postEvents.length,
        socialScheduled: scheduledSocialEvents.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    const status = message.includes("token") || message.includes("Unauthorized")
      ? 401
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  void req;
  return NextResponse.json(
    { error: "Manual calendar items are disabled." },
    { status: 410 },
  );
}
