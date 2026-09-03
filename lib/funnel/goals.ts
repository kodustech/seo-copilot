import type { SupabaseClient } from "@supabase/supabase-js";

import { listBets, type Bet } from "@/lib/bets";
import { listGoals, updateGoal, type Goal } from "@/lib/goals";

import type { FunnelData } from "./metrics";

/**
 * Funnel metrics a goal may target. Only stages the funnel measures every
 * month qualify: a goal on anything else would have nobody to write its
 * progress.
 */
export const FUNNEL_METRICS: { id: string; label: string; unit: string }[] = [
  { id: "visits", label: "Qualified visits", unit: "clicks" },
  { id: "signups", label: "Corporate-email signups", unit: "signups" },
  { id: "icp", label: "ICP (20+ devs)", unit: "accounts" },
  { id: "sh_instances", label: "Self-hosted: new instances with usage", unit: "instances" },
  { id: "sh_trial", label: "Self-hosted: trial requests", unit: "requests" },
  { id: "ob_contacts", label: "Outbound: new contacts", unit: "people" },
  { id: "ob_replies", label: "Outbound: replies", unit: "replies" },
  { id: "conversations", label: "Conversations (engaged)", unit: "accounts" },
  { id: "meetings", label: "Meetings", unit: "meetings" },
  { id: "opportunities", label: "Opportunities", unit: "accounts" },
  { id: "self_serve", label: "Self-serve (paid without a conversation)", unit: "accounts" },
  { id: "closed", label: "Closed (R$)", unit: "R$" },
];

const FUNNEL_METRIC_IDS = new Set(FUNNEL_METRICS.map((m) => m.id));

export function isFunnelMetric(id: string | null | undefined): boolean {
  return Boolean(id) && FUNNEL_METRIC_IDS.has(id as string);
}

/**
 * Goals drawn on the funnel for a given month: bound to a funnel metric and
 * with a period that IS that month. A weekly goal is synced (below) but not
 * drawn on the monthly canvas; its number would be a different window.
 */
export async function goalsForMonth(client: SupabaseClient, month: string): Promise<Goal[]> {
  const all = await listGoals(client, { periodScope: "all", status: "active", limit: 500 });
  return all.filter(
    (g) =>
      g.funnelMetric &&
      isFunnelMetric(g.funnelMetric) &&
      g.periodStart.slice(0, 7) === month &&
      g.periodEnd.slice(0, 7) === month &&
      g.periodStart.endsWith("-01"),
  );
}

/** Targets and bets per funnel node, for the page. */
export async function goalOverlay(
  client: SupabaseClient,
  month: string,
): Promise<{ targets: Record<string, { goalId: string; title: string; target: number }>; bets: Record<string, Bet[]> }> {
  const goals = await goalsForMonth(client, month);
  const targets: Record<string, { goalId: string; title: string; target: number }> = {};
  const bets: Record<string, Bet[]> = {};
  if (goals.length === 0) return { targets, bets };
  const metricByGoal = new Map<string, string>();
  for (const g of goals) {
    const id = g.funnelMetric as string;
    metricByGoal.set(g.id, id);
    // One goal per metric per month; the first (oldest) wins if two exist.
    if (!targets[id]) targets[id] = { goalId: g.id, title: g.title, target: g.targetCount };
  }
  // One query for every goal's bets instead of one per goal.
  for (const b of await listBets(client, { goalIds: [...metricByGoal.keys()] })) {
    const id = metricByGoal.get(b.goalId);
    if (!id) continue;
    bets[id] = [...(bets[id] ?? []), b];
  }
  return { targets, bets };
}

/**
 * Write the measured value of each funnel-bound goal into current_count.
 * Runs weekly (cron) and on demand. The funnel is computed once per month
 * that any goal touches.
 */
export async function syncFunnelGoals(
  client: SupabaseClient,
  fetchFunnel: (client: SupabaseClient, month: string) => Promise<FunnelData>,
): Promise<{ goals: number; updated: number; skipped: string[]; errors: string[] }> {
  const all = await listGoals(client, { periodScope: "all", status: "active", limit: 500 });
  const bound = all.filter((g) => isFunnelMetric(g.funnelMetric));
  // One funnel computation per distinct period (week, month, whatever the
  // goal says), so a weekly goal gets its own week, not the month around it.
  const byPeriod = new Map<string, FunnelData>();
  let updated = 0;
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const g of bound) {
    const period = `${g.periodStart}..${g.periodEnd}`;
    try {
      let funnel = byPeriod.get(period);
      if (!funnel) {
        funnel = await fetchFunnel(client, period);
        byPeriod.set(period, funnel);
      }
      const node = funnel.nodes[g.funnelMetric as string];
      if (!node || node.value == null) {
        skipped.push(`${g.title}: ${g.funnelMetric} not measured in ${period}`);
        continue;
      }
      const value = Math.round(node.value);
      if (value !== g.currentCount) {
        await updateGoal(client, g.id, { currentCount: value });
        updated += 1;
      }
    } catch (err) {
      errors.push(`${g.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { goals: bound.length, updated, skipped, errors };
}
