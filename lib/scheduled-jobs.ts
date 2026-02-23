import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { getModel } from "@/lib/ai/provider";
import { GROWTH_AGENT_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { createAgentTools } from "@/lib/ai/tools";
import { CronExpressionParser } from "cron-parser";
export {
  DEFAULT_SCHEDULE_TIME,
  SCHEDULE_PRESETS,
  SCHEDULE_PRESET_VALUES,
  type SchedulePreset,
  buildCronExpressionForSchedule,
  describeCronExpression,
  normalizeSchedulePreset,
  normalizeScheduleTime,
} from "@/lib/schedule-presets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduledJob = {
  id: string;
  user_email: string;
  name: string;
  prompt: string;
  cron_expression: string;
  webhook_url: string;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
};

export type JobRun = {
  id: string;
  job_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  result_summary: string | null;
  error: string | null;
  webhook_status: number | null;
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createJob(
  client: SupabaseClient,
  data: {
    user_email: string;
    name: string;
    prompt: string;
    cron_expression: string;
    webhook_url: string;
  },
): Promise<ScheduledJob> {
  const { data: job, error } = await client
    .from("scheduled_jobs")
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`Error while criar job: ${error.message}`);
  return job as ScheduledJob;
}

export async function listJobsByEmail(
  client: SupabaseClient,
  email: string,
): Promise<ScheduledJob[]> {
  const { data, error } = await client
    .from("scheduled_jobs")
    .select("*")
    .eq("user_email", email)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Error while listar jobs: ${error.message}`);
  return (data ?? []) as ScheduledJob[];
}

export async function getJobById(
  client: SupabaseClient,
  id: string,
): Promise<ScheduledJob | null> {
  const { data, error } = await client
    .from("scheduled_jobs")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as ScheduledJob;
}

export async function deleteJob(
  client: SupabaseClient,
  id: string,
  email: string,
): Promise<boolean> {
  const { error } = await client
    .from("scheduled_jobs")
    .delete()
    .eq("id", id)
    .eq("user_email", email);

  if (error) throw new Error(`Error while deletar job: ${error.message}`);
  return true;
}

export async function toggleJob(
  client: SupabaseClient,
  id: string,
  email: string,
  enabled: boolean,
): Promise<ScheduledJob> {
  const { data, error } = await client
    .from("scheduled_jobs")
    .update({ enabled })
    .eq("id", id)
    .eq("user_email", email)
    .select()
    .single();

  if (error) throw new Error(`Error while atualizar job: ${error.message}`);
  return data as ScheduledJob;
}

export async function listJobRuns(
  client: SupabaseClient,
  jobId: string,
  limit = 10,
): Promise<JobRun[]> {
  const { data, error } = await client
    .from("job_runs")
    .select("*")
    .eq("job_id", jobId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Error while listar runs: ${error.message}`);
  return (data ?? []) as JobRun[];
}

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

export function isJobDue(
  cronExpression: string,
  lastRunAt: string | null,
  now: Date,
): boolean {
  try {
    const expr = CronExpressionParser.parse(cronExpression, {
      currentDate: now,
      tz: "America/Sao_Paulo",
    });
    const prev = expr.prev().toDate();

    if (!lastRunAt) return true;

    return prev.getTime() > new Date(lastRunAt).getTime();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Execute job
// ---------------------------------------------------------------------------

export async function executeJob(
  client: SupabaseClient,
  job: ScheduledJob,
): Promise<{ success: boolean; runId: string }> {
  // 1. Insert run
  const { data: run, error: runError } = await client
    .from("job_runs")
    .insert({ job_id: job.id, status: "running" })
    .select()
    .single();

  if (runError) throw new Error(`Error while criar run: ${runError.message}`);
  const runId = (run as JobRun).id;

  try {
    // 2. Generate text (non-streaming)
    const result = await generateText({
      model: getModel(),
      system: GROWTH_AGENT_SYSTEM_PROMPT,
      prompt: job.prompt,
      tools: createAgentTools(job.user_email),
      stopWhen: stepCountIs(10),
    });

    // 3. Extract tools used
    const toolsUsed = result.steps.flatMap((step) =>
      step.toolCalls.map((tc) => tc.toolName),
    );

    // 4. POST webhook
    const webhookPayload = {
      job_name: job.name,
      prompt: job.prompt,
      response: result.text,
      executed_at: new Date().toISOString(),
      tools_used: [...new Set(toolsUsed)],
      status: "completed",
    };

    let webhookStatus = 0;
    try {
      const res = await fetch(job.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload),
      });
      webhookStatus = res.status;
    } catch {
      webhookStatus = 0;
    }

    // 5. Update run + last_run_at
    const summary =
      result.text.slice(0, 500) + (result.text.length > 500 ? "..." : "");

    await client
      .from("job_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        result_summary: summary,
        webhook_status: webhookStatus,
      })
      .eq("id", runId);

    await client
      .from("scheduled_jobs")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", job.id);

    return { success: true, runId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";

    await client
      .from("job_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: errorMsg,
      })
      .eq("id", runId);

    await client
      .from("scheduled_jobs")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", job.id);

    return { success: false, runId };
  }
}
