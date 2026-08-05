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
  const [
    { getSupabaseServiceClient },
    { isJobDue, executeJob },
    { ensureTodayYoloBatchForUser, getDefaultYoloUsers },
  ] = await Promise.all([
    import("@/lib/supabase-server"),
    import("@/lib/scheduled-jobs"),
    import("@/lib/social-yolo"),
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

  const yoloUsers = getDefaultYoloUsers();
  for (const userEmail of yoloUsers) {
    try {
      await ensureTodayYoloBatchForUser({ client, userEmail, now });
    } catch (err) {
      console.error(`[cron] YOLO batch for ${userEmail} failed:`, err);
    }
  }
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
  const { processDueSequenceTasks } = await import("@/lib/outreach/sequences");
  const res = await processDueSequenceTasks(getSupabaseServiceClient(), {
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

const JOBS: JobDefinition[] = [
  {
    name: "scheduled-jobs + YOLO",
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
