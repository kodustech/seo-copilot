import { NextResponse } from "next/server";
import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  DEFAULT_SCHEDULE_TIME,
  SCHEDULE_PRESET_VALUES,
  buildCronExpressionForSchedule,
  createJob,
  listJobsByEmail,
  normalizeSchedulePreset,
  normalizeScheduleTime,
} from "@/lib/scheduled-jobs";

export async function GET(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const jobs = await listJobsByEmail(client, userEmail);
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const body = await req.json();
    const { name, prompt, schedule, time, webhook_url } = body as {
      name?: string;
      prompt?: string;
      schedule?: string;
      time?: string;
      webhook_url?: string;
    };

    if (!name || !prompt || !schedule || !webhook_url) {
      return NextResponse.json(
        { error: "Missing required fields: name, prompt, schedule, webhook_url" },
        { status: 400 },
      );
    }

    const preset = normalizeSchedulePreset(schedule);
    if (!preset) {
      return NextResponse.json(
        { error: `Invalid schedule preset. Valid: ${SCHEDULE_PRESET_VALUES.join(", ")}` },
        { status: 400 },
      );
    }

    const selectedTime = typeof time === "string" && time.trim()
      ? normalizeScheduleTime(time)
      : DEFAULT_SCHEDULE_TIME;

    if (!selectedTime) {
      return NextResponse.json(
        { error: "Invalid time. Use HH:mm (24-hour format)." },
        { status: 400 },
      );
    }

    const cronExpression = buildCronExpressionForSchedule(preset, selectedTime);
    if (!cronExpression) {
      return NextResponse.json(
        { error: "Could not build cron expression from provided schedule/time." },
        { status: 400 },
      );
    }

    const job = await createJob(client, {
      user_email: userEmail,
      name,
      prompt,
      cron_expression: cronExpression,
      webhook_url,
    });

    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status = message.includes("Unauthorized") || message.includes("token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
