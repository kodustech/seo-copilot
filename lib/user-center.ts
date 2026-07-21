import type { SupabaseClient } from "@supabase/supabase-js";

import { listCompanies, type CompanyWithIdle } from "@/lib/crm";
import { listProspects, type OutreachProspect } from "@/lib/outreach";
import { listGoals, type Goal } from "@/lib/goals";
import { listWorkItems, type GrowthWorkItem } from "@/lib/kanban";
import { listJobsByEmail, listJobRuns, type ScheduledJob } from "@/lib/scheduled-jobs";

// ---------------------------------------------------------------------------
// User Control Center — aggregates everything assigned to one user across the
// tools, and derives an "attention" feed (the pending / at-risk items). The
// same attention list feeds the persistent notification generator.
// ---------------------------------------------------------------------------

export type Severity = "info" | "warning" | "error";

export type AttentionItem = {
  kind:
    | "crm_idle"
    | "kanban_overdue"
    | "outreach_followup"
    | "goal_at_risk"
    | "job_failed"
    | "reply_pending";
  source: "crm" | "kanban" | "outreach" | "goals" | "jobs" | "reply_radar";
  severity: Severity;
  title: string;
  body: string | null;
  sourceId: string;
  link: string;
  dedupeKey: string;
};

export type KanbanSummary = {
  pending: number;
  overdue: number;
  items: {
    id: string;
    title: string;
    stage: string;
    priority: string;
    dueAt: string | null;
    link: string | null;
    overdue: boolean;
  }[];
};

export type UserOverview = {
  userEmail: string;
  generatedAt: string;
  counts: {
    attention: number;
    kanban: number;
    crm: number;
    outreach: number;
    goals: number;
    jobs: number;
    replyRadar: number;
  };
  attention: AttentionItem[];
  kanban: KanbanSummary;
  crm: {
    total: number;
    idle: number;
    companies: {
      id: string;
      name: string;
      status: string;
      isStale: boolean;
      idleDays: number | null;
    }[];
  };
  outreach: {
    total: number;
    followupDue: number;
    prospects: {
      id: string;
      domain: string;
      status: string;
      nextFollowupAt: string | null;
      due: boolean;
    }[];
  };
  goals: {
    total: number;
    atRisk: number;
    items: {
      id: string;
      title: string;
      currentCount: number;
      targetCount: number;
      progress: number;
      pace: number;
      atRisk: boolean;
      periodEnd: string;
    }[];
  };
  jobs: {
    total: number;
    failing: number;
    items: { id: string; name: string; enabled: boolean; lastStatus: string | null }[];
  };
  replyRadar: { pending: number };
};

const TERMINAL_STAGES = new Set(["published", "live", "done", "lost", "archived"]);

function startOfTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isPastDate(iso: string | null): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) < startOfTodayIso();
}

function isDueDate(iso: string | null): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) <= startOfTodayIso();
}

// Fraction of the goal period that has elapsed (0..1).
function elapsedFraction(periodStart: string, periodEnd: string): number {
  const s = new Date(periodStart).getTime();
  const e = new Date(periodEnd).getTime();
  const now = Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 1;
  return Math.min(1, Math.max(0, (now - s) / (e - s)));
}

// ---------------------------------------------------------------------------

export async function getUserOverview(
  client: SupabaseClient,
  userEmail: string,
): Promise<UserOverview> {
  const [allWorkItems, companies, prospects, goals, jobs, replyPending] =
    await Promise.all([
      listWorkItems(client).catch(() => [] as GrowthWorkItem[]),
      listCompanies(client, { ownerEmail: userEmail, limit: 500 }).catch(
        () => [] as CompanyWithIdle[],
      ),
      listProspects(client, { responsibleEmail: userEmail, limit: 500 }).catch(
        () => [] as OutreachProspect[],
      ),
      listGoals(client, {
        responsibleEmail: userEmail,
        status: "active",
        periodScope: "current",
        limit: 200,
      }).catch(() => [] as Goal[]),
      listJobsByEmail(client, userEmail).catch(() => [] as ScheduledJob[]),
      countPendingReplies(client, userEmail).catch(() => 0),
    ]);

  const attention: AttentionItem[] = [];

  // ── Kanban ──────────────────────────────────────────────────────────────
  const myItems = allWorkItems.filter(
    (i) => i.responsibleEmail === userEmail && !TERMINAL_STAGES.has(i.stage),
  );
  const kanbanItems = myItems.map((i) => {
    const overdue = isPastDate(i.dueAt);
    if (overdue) {
      attention.push({
        kind: "kanban_overdue",
        source: "kanban",
        severity: "warning",
        title: `Overdue card: ${i.title}`,
        body: `Due ${i.dueAt?.slice(0, 10)} · stage ${i.stage}`,
        sourceId: i.id,
        link: "/kanban",
        dedupeKey: `kanban_overdue:${i.id}:${i.dueAt?.slice(0, 10)}`,
      });
    }
    return {
      id: i.id,
      title: i.title,
      stage: i.stage,
      priority: i.priority,
      dueAt: i.dueAt,
      link: i.link,
      overdue,
    };
  });

  // ── CRM ─────────────────────────────────────────────────────────────────
  const crmCompanies = companies.map((c) => {
    if (c.isStale) {
      attention.push({
        kind: "crm_idle",
        source: "crm",
        severity: "warning",
        title: `Idle account: ${c.name}`,
        body: `${c.idleDays ?? "?"}d with no activity · status ${c.status}`,
        sourceId: c.id,
        link: "/crm",
        dedupeKey: `crm_idle:${c.id}`,
      });
    }
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      isStale: c.isStale,
      idleDays: c.idleDays,
    };
  });

  // ── Outreach ────────────────────────────────────────────────────────────
  const activeProspects = prospects.filter(
    (p) => p.status !== "won" && p.status !== "lost",
  );
  const outreachItems = activeProspects.map((p) => {
    const due = isDueDate(p.nextFollowupAt);
    if (due) {
      attention.push({
        kind: "outreach_followup",
        source: "outreach",
        severity: "info",
        title: `Follow-up: ${p.domain}`,
        body: `Scheduled for ${p.nextFollowupAt?.slice(0, 10)} · status ${p.status}`,
        sourceId: p.id,
        link: "/outreach",
        dedupeKey: `outreach_followup:${p.id}:${p.nextFollowupAt?.slice(0, 10)}`,
      });
    }
    return {
      id: p.id,
      domain: p.domain,
      status: p.status,
      nextFollowupAt: p.nextFollowupAt,
      due,
    };
  });

  // ── Goals ───────────────────────────────────────────────────────────────
  const goalItems = goals.map((g) => {
    const progress = g.targetCount > 0 ? g.currentCount / g.targetCount : 1;
    const pace = elapsedFraction(g.periodStart, g.periodEnd);
    // Behind by more than 15 percentage points of expected pace.
    const atRisk = progress < pace - 0.15;
    if (atRisk) {
      attention.push({
        kind: "goal_at_risk",
        source: "goals",
        severity: "warning",
        title: `Goal at risk: ${g.title}`,
        body: `${g.currentCount}/${g.targetCount} (${Math.round(progress * 100)}%) · expected pace ${Math.round(pace * 100)}%`,
        sourceId: g.id,
        link: "/goals",
        dedupeKey: `goal_at_risk:${g.id}:${g.periodEnd}`,
      });
    }
    return {
      id: g.id,
      title: g.title,
      currentCount: g.currentCount,
      targetCount: g.targetCount,
      progress,
      pace,
      atRisk,
      periodEnd: g.periodEnd,
    };
  });

  // ── Scheduled jobs (last-run failure) ─────────────────────────────────────
  const jobItems = await Promise.all(
    jobs.map(async (j) => {
      let lastStatus: string | null = null;
      if (j.enabled) {
        const runs = await listJobRuns(client, j.id, 1).catch(() => []);
        lastStatus = runs[0]?.status ?? null;
        if (lastStatus === "failed") {
          attention.push({
            kind: "job_failed",
            source: "jobs",
            severity: "error",
            title: `Job failed: ${j.name}`,
            body: runs[0]?.error?.slice(0, 160) ?? "Last run failed",
            sourceId: j.id,
            link: "/jobs",
            dedupeKey: `job_failed:${j.id}:${runs[0]?.id ?? "last"}`,
          });
        }
      }
      return { id: j.id, name: j.name, enabled: j.enabled, lastStatus };
    }),
  );

  // Social inbox (reply-radar) removed from product surface — no attention items.

  // Severity ordering for the feed: error → warning → info.
  const sevRank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  attention.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  return {
    userEmail,
    generatedAt: new Date().toISOString(),
    counts: {
      attention: attention.length,
      kanban: kanbanItems.length,
      crm: crmCompanies.length,
      outreach: outreachItems.length,
      goals: goalItems.length,
      jobs: jobItems.length,
      replyRadar: replyPending,
    },
    attention,
    kanban: {
      pending: kanbanItems.length,
      overdue: kanbanItems.filter((i) => i.overdue).length,
      items: kanbanItems,
    },
    crm: {
      total: crmCompanies.length,
      idle: crmCompanies.filter((c) => c.isStale).length,
      companies: crmCompanies,
    },
    outreach: {
      total: outreachItems.length,
      followupDue: outreachItems.filter((p) => p.due).length,
      prospects: outreachItems,
    },
    goals: {
      total: goalItems.length,
      atRisk: goalItems.filter((g) => g.atRisk).length,
      items: goalItems,
    },
    jobs: {
      total: jobItems.length,
      failing: jobItems.filter((j) => j.lastStatus === "failed").length,
      items: jobItems,
    },
    replyRadar: { pending: replyPending },
  };
}

// Reply candidates awaiting the user's action (not yet sent/skipped).
async function countPendingReplies(
  client: SupabaseClient,
  userEmail: string,
): Promise<number> {
  const { count, error } = await client
    .from("x_reply_candidates")
    .select("id", { count: "exact", head: true })
    .eq("user_email", userEmail)
    .in("status", ["new", "drafted"]);
  if (error) return 0;
  return count ?? 0;
}
