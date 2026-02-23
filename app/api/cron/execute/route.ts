import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { isJobDue, executeJob, type ScheduledJob } from "@/lib/scheduled-jobs";
import {
  ensureTodayYoloBatchForUser,
  getDefaultYoloUsers,
  socialYoloTableMissingMessage,
} from "@/lib/social-yolo";

export const maxDuration = 300;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = getSupabaseServiceClient();
  const now = new Date();

  // Fetch all enabled jobs
  const { data: jobs, error } = await client
    .from("scheduled_jobs")
    .select("*")
    .eq("enabled", true);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const allJobs = (jobs ?? []) as ScheduledJob[];
  const dueJobs = allJobs.filter((job) =>
    isJobDue(job.cron_expression, job.last_run_at, now),
  );

  const results: { job_id: string; name: string; success: boolean; error?: string }[] = [];

  for (const job of dueJobs) {
    try {
      const { success } = await executeJob(client, job);
      results.push({ job_id: job.id, name: job.name, success });
    } catch (err) {
      results.push({
        job_id: job.id,
        name: job.name,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const yoloResults: Array<{
    user_email: string;
    generated: boolean;
    batch_date?: string;
    count?: number;
    error?: string;
  }> = [];

  const yoloUsers = getDefaultYoloUsers();
  for (const userEmail of yoloUsers) {
    try {
      const yolo = await ensureTodayYoloBatchForUser({
        client,
        userEmail,
        now,
      });
      yoloResults.push({
        user_email: userEmail,
        generated: yolo.generated,
        batch_date: yolo.batchDate,
        count: yolo.count,
      });
    } catch (err) {
      const missingMessage = socialYoloTableMissingMessage(err);
      yoloResults.push({
        user_email: userEmail,
        generated: false,
        error:
          missingMessage ??
          (err instanceof Error ? err.message : "Unknown error"),
      });
    }
  }

  return NextResponse.json({
    checked: allJobs.length,
    executed: dueJobs.length,
    results,
    yolo: {
      users: yoloUsers.length,
      results: yoloResults,
    },
  });
}
