import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { isJobDue, executeJob, type ScheduledJob } from "@/lib/scheduled-jobs";

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

  return NextResponse.json({
    checked: allJobs.length,
    executed: dueJobs.length,
    results,
  });
}
