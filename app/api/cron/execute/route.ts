import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase-server";
import { isJobDue, executeJob, type ScheduledJob } from "@/lib/scheduled-jobs";
import { materializeDueRecurrences } from "@/lib/goal-recurrences";

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

  // The YOLO batch builder ran here until the SEO & production screens were
  // removed. It also ran in lib/cron/scheduler.ts, and removing it from only
  // one of the two left the publisher alive on the other: this route is wired
  // to Vercel Cron hourly (vercel.json), so daily social batches would have
  // kept queueing with no screen left to review or stop them — the exact
  // outcome deleting the screens was meant to avoid.
  // Materialize the current-period goal instance for every active recurrence
  // rule. Idempotent (unique index on recurrence_id + period_start), so running
  // hourly just no-ops until a new period rolls over.
  let recurrenceSummary: {
    rules: number;
    created: number;
    error?: string;
  };
  try {
    const recurrenceResults = await materializeDueRecurrences(client, now);
    recurrenceSummary = {
      rules: recurrenceResults.length,
      created: recurrenceResults.filter((r) => r.created).length,
    };
  } catch (err) {
    recurrenceSummary = {
      rules: 0,
      created: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }

  return NextResponse.json({
    checked: allJobs.length,
    executed: dueJobs.length,
    results,
    recurrences: recurrenceSummary,
  });
}
