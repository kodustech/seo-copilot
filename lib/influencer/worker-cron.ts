/**
 * persona-worker: executes the persona's planned tasks autonomously. Picks due
 * tasks, runs an agent session per task, records the outcome, and raises an
 * operator alert on failure. Drafts still land in the review queue — the worker
 * never publishes. This is the "you don't have to keep telling it" loop.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseServiceClient } from "@/lib/supabase-server";

import { runInfluencerAgentSession } from "@/lib/influencer/agent";
import { alertOperator } from "@/lib/influencer/alerts";
import { getPersona } from "@/lib/influencer/personas";
import {
  claimTask,
  finishTask,
  listDueTasks,
  resetStaleTasks,
} from "@/lib/influencer/tasks";

const MAX_TASKS_PER_RUN = 10;
const STALE_MS = 30 * 60 * 1000;

export type WorkerSummary = {
  examined: number;
  done: number;
  failed: number;
  skipped: number;
};

export async function runInfluencerWorkerCron(
  options: { client?: SupabaseClient; now?: Date } = {},
): Promise<WorkerSummary> {
  const client = options.client ?? getSupabaseServiceClient();
  const now = options.now ?? new Date();
  const summary: WorkerSummary = { examined: 0, done: 0, failed: 0, skipped: 0 };

  const reset = await resetStaleTasks(
    client,
    new Date(now.getTime() - STALE_MS).toISOString(),
  );
  if (reset > 0) console.warn(`[influencer-worker] reset ${reset} stale task(s)`);

  const due = await listDueTasks(client, now.toISOString(), MAX_TASKS_PER_RUN);

  for (const task of due) {
    summary.examined += 1;

    // Atomic claim so parallel workers don't double-run a task.
    const claimed = await claimTask(client, task.id);
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }

    const persona = await getPersona(client, task.persona_id);
    if (!persona || persona.status !== "active") {
      await finishTask(client, task.id, {
        status: "cancelled",
        error: persona ? "persona is paused" : "persona no longer exists",
      });
      summary.skipped += 1;
      continue;
    }

    try {
      const result = await runInfluencerAgentSession({
        client,
        persona,
        goal: task.goal,
        trigger: "scheduled",
      });
      if (result.status === "completed") {
        await finishTask(client, task.id, {
          status: "done",
          session_id: result.session_id,
          result_summary: `${result.drafts} draft(s) queued`,
        });
        summary.done += 1;
      } else {
        await finishTask(client, task.id, {
          status: "failed",
          session_id: result.session_id,
          error: result.error ?? "session failed",
        });
        await alertOperator(client, {
          userEmail: persona.created_by,
          title: `@${persona.handle}: a task failed`,
          body: `"${task.title}" — ${result.error ?? "unknown error"}`,
          dedupeKey: `task-fail-${task.id}`,
        });
        summary.failed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishTask(client, task.id, { status: "failed", error: message });
      await alertOperator(client, {
        userEmail: persona.created_by,
        title: `@${persona.handle}: a task crashed`,
        body: `"${task.title}" — ${message}`,
        dedupeKey: `task-fail-${task.id}`,
      });
      summary.failed += 1;
    }
  }

  return summary;
}
