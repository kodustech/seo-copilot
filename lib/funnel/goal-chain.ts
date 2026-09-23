import type { Goal } from "@/lib/goals";

import { FUNNEL_METRICS } from "./goals";
import { FUNNEL_EDGES, FUNNEL_LANES } from "./graph";

/**
 * How the goals feed each other, read off the funnel graph. A goal bound to
 * a stage sits where that stage sits; the edges between stages are the only
 * source of "this goal moves that one". Goals with no stage stay off the
 * chain: nothing in the data says where they belong.
 */

/** The lane every entry lane feeds. */
export const BAND_LANE_ID = "commercial";

const GOAL_STAGES = new Set(FUNNEL_METRICS.map((m) => m.id));

export type ChainStage = { id: string; label: string };
export type ChainLane = { id: string; title: string; stages: ChainStage[] };

/** "Self-hosted: trial requests" → "trial requests"; "ICP (20+ devs)" → "ICP". The lane already says which one. */
export function stageLabel(id: string): string {
  const label = FUNNEL_METRICS.find((m) => m.id === id)?.label ?? id;
  const noLane = label.replace(/^[^:]+:\s*/, "");
  const noNote = noLane.replace(/\s*\(.*\)\s*$/, "");
  return noNote.charAt(0).toUpperCase() + noNote.slice(1);
}

/** Lanes in funnel order, holding only the stages a goal can bind to. */
export const CHAIN_LANES: ChainLane[] = FUNNEL_LANES.map((lane) => ({
  id: lane.id,
  title: lane.title,
  stages: lane.stages.filter((s) => GOAL_STAGES.has(s)).map((s) => ({ id: s, label: stageLabel(s) })),
})).filter((lane) => lane.stages.length > 0);

// Adjacency built once; every walk below reads from these.
const CHILDREN = new Map<string, string[]>();
const PARENTS = new Map<string, string[]>();
for (const e of FUNNEL_EDGES) {
  CHILDREN.set(e.from, [...(CHILDREN.get(e.from) ?? []), e.to]);
  PARENTS.set(e.to, [...(PARENTS.get(e.to) ?? []), e.from]);
}

export function hasEdge(from: string, to: string): boolean {
  return CHILDREN.get(from)?.includes(to) ?? false;
}

const depthCache = new Map<string, number>();

/** Longest path from any entry stage: 0 for an entry, higher is further down the funnel. */
export function stageDepth(stage: string, seen: Set<string> = new Set()): number {
  const cached = depthCache.get(stage);
  if (cached != null) return cached;
  if (seen.has(stage)) return 0;
  seen.add(stage);
  const parents = PARENTS.get(stage) ?? [];
  const depth = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => stageDepth(p, seen)));
  depthCache.set(stage, depth);
  return depth;
}

function overlaps(a: Goal, b: Goal): boolean {
  return a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd;
}

function boundStage(g: Goal): string | null {
  return g.funnelMetric && GOAL_STAGES.has(g.funnelMetric) ? g.funnelMetric : null;
}

/**
 * The nearest goals in one direction: walk the edges from the goal's stage
 * and stop at the first stage that carries a goal of an overlapping period.
 * Nearest only, so Visits → ICP → Opportunities reads as a chain instead of
 * every upstream goal pointing at the last one.
 */
function nearest(goal: Goal, goals: Goal[], direction: "down" | "up"): Goal[] {
  const start = boundStage(goal);
  if (!start) return [];
  const peers = goals.filter((g) => g.id !== goal.id && boundStage(g) && overlaps(g, goal));
  const found: Goal[] = [];
  const seen = new Set([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const stage of frontier) {
      const neighbours = (direction === "down" ? CHILDREN : PARENTS).get(stage) ?? [];
      for (const n of neighbours) {
        if (seen.has(n)) continue;
        seen.add(n);
        const here = peers.filter((g) => g.funnelMetric === n);
        if (here.length > 0) found.push(...here);
        else next.push(n);
      }
    }
    frontier = next;
  }
  return found.sort((a, b) => stageDepth(a.funnelMetric as string) - stageDepth(b.funnelMetric as string));
}

export function feedsGoals(goal: Goal, goals: Goal[]): Goal[] {
  return nearest(goal, goals, "down");
}

export function fedByGoals(goal: Goal, goals: Goal[]): Goal[] {
  return nearest(goal, goals, "up");
}

export type GoalChain = {
  /** Lanes with each goal-able stage and the goals bound to it. */
  lanes: Array<ChainLane & { goalsByStage: Record<string, Goal[]>; goalCount: number }>;
  /** Goals with no stage; progress comes from somewhere the funnel doesn't know. */
  unplaced: Goal[];
  /** Bound goals nothing downstream depends on: where the chain ends. */
  endIds: Set<string>;
};

export function buildGoalChain(goals: Goal[]): GoalChain {
  const byStage = new Map<string, Goal[]>();
  for (const g of goals) {
    if (g.funnelMetric) byStage.set(g.funnelMetric, [...(byStage.get(g.funnelMetric) ?? []), g]);
  }
  const lanes = CHAIN_LANES.map((lane) => {
    const goalsByStage: Record<string, Goal[]> = {};
    let goalCount = 0;
    for (const s of lane.stages) {
      const here = byStage.get(s.id) ?? [];
      goalsByStage[s.id] = here;
      goalCount += here.length;
    }
    return { ...lane, goalsByStage, goalCount };
  });
  // A stage the funnel measures but no lane draws still counts as off the
  // map, so its goal lands in "unplaced" instead of vanishing from the page.
  const drawn = new Set(CHAIN_LANES.flatMap((l) => l.stages.map((s) => s.id)));
  const placed = goals.filter((g) => g.funnelMetric && drawn.has(g.funnelMetric));
  const endIds = new Set(placed.filter((g) => feedsGoals(g, goals).length === 0 && fedByGoals(g, goals).length > 0).map((g) => g.id));
  return { lanes, unplaced: goals.filter((g) => !g.funnelMetric || !drawn.has(g.funnelMetric)), endIds };
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Name a goal by its stage, adding its period when another goal in the list
 * sits on the same stage. Recurring goals share a title, so the period is
 * what tells two weekly "Meetings" apart.
 */
export function goalLabel(goal: Goal, among: Goal[]): string {
  if (!goal.funnelMetric) return goal.title;
  const label = stageLabel(goal.funnelMetric);
  const twins = among.filter((g) => g.funnelMetric === goal.funnelMetric);
  if (twins.length < 2) return label;
  return `${label} · ${shortDate(goal.periodStart)}–${shortDate(goal.periodEnd)}`;
}

/** Share of the period elapsed today, or null when the period is not running. */
export function elapsedShare(goal: Pick<Goal, "periodStart" | "periodEnd">, today: Date = new Date()): number | null {
  const day = 86_400_000;
  const start = new Date(`${goal.periodStart}T00:00:00`).getTime();
  const end = new Date(`${goal.periodEnd}T00:00:00`).getTime() + day;
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() + day;
  if (now <= start || now > end) return null;
  return (now - start) / (end - start);
}
