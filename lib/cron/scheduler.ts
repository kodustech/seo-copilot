import cron, { type ScheduledTask } from "node-cron";

// All schedules run in UTC.
const CRON_TIMEZONE = "UTC";

const isTrue = (value: string | undefined) =>
  typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());

function shouldStartCrons(): boolean {
  // Opt-out: let ops disable quickly without redeploying.
  if (isTrue(process.env.DISABLE_CRONS)) return false;

  // In production, run by default unless CRON_LEADER is explicitly "0" (used
  // when scaling Railway to >1 replicas — only one instance should carry crons).
  if (process.env.NODE_ENV === "production") {
    if (process.env.CRON_LEADER === "0") return false;
    return true;
  }

  // In dev, stay quiet unless explicitly enabled.
  return isTrue(process.env.ENABLE_CRONS);
}

type JobDefinition = {
  name: string;
  schedule: string;
  run: () => Promise<unknown>;
};

let started = false;
const tasks: ScheduledTask[] = [];

async function runScheduledJobsCron(): Promise<void> {
  const [{ getSupabaseServiceClient }, { isJobDue, executeJob }] =
    await Promise.all([
      import("@/lib/supabase-server"),
      import("@/lib/scheduled-jobs"),
    ]);

  const client = getSupabaseServiceClient();
  const now = new Date();

  const { data: jobs, error } = await client
    .from("scheduled_jobs")
    .select("*")
    .eq("enabled", true);

  if (error) throw new Error(error.message);

  type Job = {
    id: string;
    name: string;
    cron_expression: string;
    last_run_at: string | null;
  };

  const allJobs = (jobs ?? []) as Job[];
  const due = allJobs.filter((job) =>
    isJobDue(job.cron_expression, job.last_run_at, now),
  );

  for (const job of due) {
    try {
      await executeJob(client, job as unknown as Parameters<typeof executeJob>[1]);
    } catch (err) {
      console.error(`[cron] scheduled_jobs.${job.name} failed:`, err);
    }
  }

  // The YOLO batch builder ran here until the SEO & production screens were
  // removed. Keeping it would have left a job that queues and publishes social
  // posts every day with no screen left to review or stop it — a publisher
  // running blind is worse than no publisher. The content work moves to a skill
  // in the local agent, which owns the scheduling too.
}

async function runLlmMentionsCron(): Promise<void> {
  const { syncLLMMentionsSnapshot } = await import("@/lib/dataforseo");
  await syncLLMMentionsSnapshot();
}

async function runSocialMonitoringCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { syncSocialMentions } = await import("@/lib/social-monitoring");
  await syncSocialMentions(getSupabaseServiceClient());
}

async function runReplyRadarCron(): Promise<void> {
  const {
    syncAllUsersCandidates,
    generateAndStoreDraftsForUser,
  } = await import("@/lib/reply-radar");

  const syncResults = await syncAllUsersCandidates();
  for (const result of syncResults) {
    if (result.totalInserted <= 0) continue;
    try {
      await generateAndStoreDraftsForUser(result.userEmail);
    } catch (err) {
      console.error(
        `[cron] reply-radar drafts for ${result.userEmail} failed:`,
        err,
      );
    }
  }
}

async function runCrmIdleCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { getStaleCompanies } = await import("@/lib/crm");

  const stale = await getStaleCompanies(getSupabaseServiceClient());
  if (stale.length === 0) return;

  const companies = stale.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    ownerEmail: c.ownerEmail,
    idleDays: c.idleDays,
    slaDays: c.slaDays,
    lastActivityAt: c.lastActivityAt,
  }));
  console.log(
    `[cron] crm-idle: ${stale.length} idle companies — ${companies
      .map((c) => c.name)
      .join(", ")}`,
  );

  // Optional fan-out (e.g. n8n → Slack). No-op if the env var is unset.
  const webhook = process.env.CRM_IDLE_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: stale.length, companies }),
      });
    } catch (err) {
      console.error("[cron] crm-idle webhook post failed:", err);
    }
  }
}

/** Re-research rows that previously passed ICP (signals change over time). */
async function runResearchRefreshCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { listTables, listRows } = await import("@/lib/research/tables");
  const { researchRows } = await import("@/lib/research/research-company");

  const client = getSupabaseServiceClient();
  const tables = await listTables(client);
  let total = 0;
  let ok = 0;
  for (const table of tables.slice(0, 5)) {
    const rows = await listRows(client, table.id, { passOnly: true });
    // Cap per table to control Exa/LLM cost.
    const ids = rows.slice(0, 15).map((r) => r.id);
    if (ids.length === 0) continue;
    total += ids.length;
    const result = await researchRows(client, ids, {
      force: true,
      concurrency: 1,
    });
    ok += result.ok;
  }
  console.log(
    `[cron] research-refresh: re-researched ${ok}/${total} pass rows across ${tables.length} tables`,
  );
}

async function runNotificationsCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { generateNotificationsForAllUsers } = await import(
    "@/lib/notifications"
  );
  const res = await generateNotificationsForAllUsers(getSupabaseServiceClient());
  console.log(
    `[cron] notifications: ${res.created} created across ${res.users} users`,
  );
}

async function runOutreachSequencesCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { processDueSequenceTasks, refreshCrmSignalVars } = await import(
    "@/lib/outreach/sequences"
  );
  const client = getSupabaseServiceClient();

  // This refresh also lives in app/api/cron/outreach-sequences/route.ts, which
  // nothing schedules — so until now it never ran anywhere. Enrollments kept
  // whatever template_vars they were frozen with at enrol time: every account
  // enrolled before a token was added to the catalog could never resolve it,
  // and the queue blocked those sends forever rather than for a tick.
  //
  // Refresh first, same as the route: an email held back for an unfilled
  // {{token}} should go out on the tick the data lands, not the next one. A
  // failure here costs freshness only and must not stop the sends.
  try {
    const refresh = await refreshCrmSignalVars(client);
    if (refresh.enrollmentsUpdated || refresh.tasksRerendered) {
      console.log(
        `[cron] outreach-sequences: signal vars refreshed on ${refresh.enrollmentsUpdated} enrollment(s), ${refresh.tasksRerendered} task(s) re-rendered`,
      );
    }
  } catch (err) {
    console.error("[cron] outreach-sequences: signal var refresh failed", err);
  }

  const res = await processDueSequenceTasks(client, {
    reseedOrphans: true,
  });
  console.log(
    `[cron] outreach-sequences: promoted ${res.promoted}, emails sent ${res.emailsSent}, failed ${res.emailsFailed}, skipped ${res.emailsSkipped}, deferred off-day ${res.deferred}, reseeded ${res.reseeded ?? 0}`,
  );
}

async function runAutoEnrollCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { runAllAutoEnrollRules } = await import("@/lib/outreach/auto-enroll");
  const res = await runAllAutoEnrollRules(getSupabaseServiceClient());
  const failed = res.results.filter((r) => r.errors.length > 0).length;
  const truncated = res.results.filter((r) => r.scanTruncated).length;
  console.log(
    `[cron] auto-enroll: ${res.rules} rules, enrolled ${res.enrolled}` +
      (failed > 0 ? `, ${failed} with errors` : "") +
      (truncated > 0
        ? `, ${truncated} whose filter reaches past the scan window (narrow the filter)`
        : ""),
  );
}

async function runOutreachInboxCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { syncAllMailboxesInbox } = await import("@/lib/outreach/inbox");
  const results = await syncAllMailboxesInbox(getSupabaseServiceClient());
  const ok = results.filter((r) => r.ok).length;
  const replied = results.reduce(
    (n, r) => n + r.enrollmentsMarkedReplied,
    0,
  );
  const touched = results.reduce((n, r) => n + r.threadsTouched, 0);
  console.log(
    `[cron] outreach-inbox: ${ok}/${results.length} mailboxes, ${touched} threads, ${replied} marked replied`,
  );
}

async function runProductSignalsCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { runProductSignalsSweep } = await import("@/lib/product-signals/sweep");
  const res = await runProductSignalsSweep(getSupabaseServiceClient());
  console.log(
    `[cron] product-signals: ${res.orgs} orgs, ${res.transitions} transitions, ` +
      `${res.companiesCreated} companies created, ${res.companiesLinked} linked, ` +
      `${res.tiersUpdated} tiers updated, ${res.contactsCreated} contacts, ` +
      `${res.orgsSharingAccount} orgs sharing an account` +
      (res.errors.length ? `, ${res.errors.length} errors: ${res.errors[0]}` : ""),
  );
}

async function runPersonaContentCron(): Promise<void> {
  const { runInfluencerContentCron } = await import("@/lib/influencer/generation");
  const results = await runInfluencerContentCron();
  const generated = results.reduce((n, r) => n + r.generated, 0);
  const failed = results.filter((r) => r.error).length;
  console.log(
    `[cron] persona-content: ${results.length} personas, ${generated} drafts` +
      (failed ? `, ${failed} failed` : ""),
  );
}

async function runPersonaPublishCron(): Promise<void> {
  const { runInfluencerPublishCron } = await import("@/lib/influencer/publish");
  const res = await runInfluencerPublishCron();
  if (res.examined > 0) {
    console.log(
      `[cron] persona-publish: examined ${res.examined}, published ${res.published}, ` +
        `deferred ${res.deferred}, rejected ${res.rejected}, failed ${res.failed}, skipped ${res.skipped}`,
    );
  }
}

async function runPersonaTickCron(): Promise<void> {
  const { runInfluencerTickCron } = await import("@/lib/influencer/tick");
  const results = await runInfluencerTickCron();
  const acted = results.filter((r) => r.acted).length;
  if (results.length) {
    const drafts = results.reduce((n, r) => n + r.drafts, 0);
    console.log(
      `[cron] persona-tick: ${results.length} due, ${acted} acted, ${drafts} draft(s) queued`,
    );
  }
}

async function runCrmMeetingsCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { syncCalendarMeetings } = await import("@/lib/crm-meetings");
  const res = await syncCalendarMeetings(getSupabaseServiceClient());
  console.log(
    `[cron] crm-meetings: ${res.mailboxes} mailbox(es), ${res.eventsScanned} events, ${res.eventsMatched} matched, ${res.companiesTouched} accounts, ${res.statusMoved} moved to meeting` +
      (res.skippedNoScope.length ? `, no calendar scope: ${res.skippedNoScope.join(", ")}` : "") +
      (res.errors.length ? `, errors: ${res.errors.length}` : ""),
  );
}

async function runFunnelGoalsCron(): Promise<void> {
  const { getSupabaseServiceClient } = await import("@/lib/supabase-server");
  const { syncFunnelGoals } = await import("@/lib/funnel/goals");
  const { fetchFunnel } = await import("@/lib/funnel/metrics");
  const res = await syncFunnelGoals(getSupabaseServiceClient(), fetchFunnel);
  console.log(
    `[cron] funnel-goals: ${res.goals} goal(s), ${res.updated} updated` +
      (res.skipped.length ? `, skipped: ${res.skipped.join("; ")}` : "") +
      (res.errors.length ? `, errors: ${res.errors.join("; ")}` : ""),
  );
}

const JOBS: JobDefinition[] = [
  {
    // Daily 06:00 UTC (03:00 BRT): write measured funnel numbers into goals.
    name: "funnel-goals",
    schedule: "0 6 * * *",
    run: runFunnelGoalsCron,
  },
  {
    // Every 2 h: match calendar events to CRM accounts (reply → meeting).
    name: "crm-meetings",
    schedule: "30 */2 * * *",
    run: runCrmMeetingsCron,
  },
  {
    name: "scheduled-jobs",
    schedule: "0 * * * *",
    run: runScheduledJobsCron,
  },
  {
    name: "llm-mentions",
    schedule: "0 8 * * *",
    run: runLlmMentionsCron,
  },
  {
    name: "social-monitoring",
    schedule: "0 9,18 * * *",
    run: runSocialMonitoringCron,
  },
  {
    name: "reply-radar",
    schedule: "0 11,16,21 * * *",
    run: runReplyRadarCron,
  },
  {
    // Daily 12:00 UTC (~09:00 BRT): flag CRM accounts idle past their SLA.
    name: "crm-idle",
    schedule: "0 12 * * *",
    run: runCrmIdleCron,
  },
  {
    // Weekly Wednesday 07:00 UTC: re-score companies that already passed ICP.
    name: "research-refresh",
    schedule: "0 7 * * 3",
    run: runResearchRefreshCron,
  },
  {
    // Every 15 min: promote due LinkedIn semi tasks to the human queue
    // (email auto send lands in PR2 / Resend).
    name: "outreach-sequences",
    schedule: "*/15 * * * *",
    run: runOutreachSequencesCron,
  },
  {
    // Hourly: resolve each active auto-enroll rule (a saved CRM filter) and
    // enrol whoever is newly matched. Hourly rather than every few minutes
    // because the inputs — tier, status, owner — change on the order of hours,
    // and each run sends real email.
    name: "auto-enroll",
    schedule: "15 * * * *",
    run: runAutoEnrollCron,
  },
  {
    // Every 10 min: sync Gmail for outbound sequence replies.
    name: "outreach-inbox",
    schedule: "*/10 * * * *",
    run: runOutreachInboxCron,
  },
  {
    // Every 4h: BigQuery → classify orgs into outbound tiers → sync CRM.
    name: "product-signals",
    schedule: "30 */4 * * *",
    run: runProductSignalsCron,
  },
  {
    // Every 3h: refresh per-user notifications from the attention feed.
    name: "notifications",
    schedule: "0 */3 * * *",
    run: runNotificationsCron,
  },
  {
    // Daily 10:00 UTC: one batch of drafts per active influencer persona.
    // Drafts only — the review screen at /influencers is where they get
    // approved; persona-publish is the only thing that touches the wire.
    name: "persona-content",
    schedule: "0 10 * * *",
    run: runPersonaContentCron,
  },
  {
    // Every 15 min: publish approved persona activities within the per-channel
    // daily caps. All hard walls (automation level, caps, fleet-amplification
    // block, forbidden topics) are enforced here, outside the model.
    name: "persona-publish",
    schedule: "*/15 * * * *",
    run: runPersonaPublishCron,
  },
  {
    // Every 15 min: the self-paced heartbeat. Wakes each active persona whose
    // self-chosen next_action_at has arrived, runs one real shift, and lets it
    // decide when to come back. Only drafts — never publishes.
    name: "persona-tick",
    schedule: "*/15 * * * *",
    run: runPersonaTickCron,
  },
];

export function startCronJobs(): void {
  if (started) return;
  if (!shouldStartCrons()) {
    console.log(
      "[cron] Scheduler disabled (set ENABLE_CRONS=1 in dev, or check DISABLE_CRONS/CRON_LEADER in prod).",
    );
    return;
  }

  for (const job of JOBS) {
    const task = cron.schedule(
      job.schedule,
      async () => {
        const startedAt = Date.now();
        console.log(`[cron] ${job.name} firing (${job.schedule} UTC)`);
        try {
          await job.run();
          console.log(
            `[cron] ${job.name} completed in ${Date.now() - startedAt}ms`,
          );
        } catch (err) {
          console.error(`[cron] ${job.name} failed:`, err);
        }
      },
      { timezone: CRON_TIMEZONE },
    );
    tasks.push(task);
    console.log(`[cron] registered "${job.name}" on "${job.schedule}" UTC`);
  }

  started = true;
}
