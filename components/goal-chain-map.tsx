"use client";

/* Hallmark · macrostructure: Workbench (app page) · tone: utilitarian · anchor hue: violet (the app's existing accent)
 * The map answers one question: which goal moves which. Lanes read top to bottom in funnel order,
 * stages left to right; arrows are funnel edges, "+" joins stages that meet further down.
 */

import { ArrowDown, ArrowLeft, ArrowRight, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Goal } from "@/lib/goals";
import { BAND_LANE_ID, elapsedShare, goalLabel, hasEdge, type GoalChain } from "@/lib/funnel/goal-chain";

export function scrollToGoal(id: string) {
  const el = document.getElementById(`goal-${id}`);
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  el.focus({ preventScroll: true });
}

/** Progress bar with a tick where the goal should be today, pro rata. */
export function ProgressLine({ goal, className }: { goal: Goal; className?: string }) {
  const pct = Math.min(100, Math.round((goal.currentCount / goal.targetCount) * 100));
  const pace = goal.status === "active" ? elapsedShare(goal) : null;
  const fill =
    goal.status === "completed"
      ? "bg-emerald-500"
      : goal.status === "missed"
        ? "bg-red-500"
        : goal.status === "active"
          ? "bg-violet-400"
          : "bg-neutral-600";
  return (
    <div
      className={cn("relative h-1.5 rounded-full bg-white/[0.06]", className)}
      title={pace != null ? `Pro-rata pace today: ${Math.round(pace * goal.targetCount)} of ${goal.targetCount}` : undefined}
    >
      <div className="h-full overflow-hidden rounded-full">
        <div className={cn("h-full transition-[width] duration-300 ease-out motion-reduce:transition-none", fill)} style={{ width: `${pct}%` }} />
      </div>
      {pace != null && pace < 1 && (
        <span aria-hidden className="absolute -top-0.5 h-2.5 w-px bg-neutral-300" style={{ left: `${pace * 100}%` }} />
      )}
    </div>
  );
}

// The node is narrow: "300000 / 500000" (Closed is in R$) has to fit.
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function GoalNode({ goal, label, isEnd }: { goal: Goal; label: string; isEnd: boolean }) {
  return (
    <button
      type="button"
      onClick={() => scrollToGoal(goal.id)}
      title={goal.title}
      className={cn(
        "w-40 rounded-lg border bg-neutral-900 px-3 py-2 text-left transition-colors hover:border-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 active:bg-neutral-800",
        isEnd ? "border-violet-400/50" : "border-white/10",
      )}
    >
      <span className="flex items-baseline justify-between gap-2 text-[11px] text-neutral-400">
        <span className="truncate">{label}</span>
        {isEnd && <span className="shrink-0 text-violet-300">end</span>}
      </span>
      <span className="mt-0.5 block text-base font-semibold tabular-nums text-white">
        {compact.format(goal.currentCount)}
        <span className="font-normal text-neutral-500"> / {compact.format(goal.targetCount)}</span>
      </span>
      <ProgressLine goal={goal} className="mt-1.5" />
    </button>
  );
}

function Connector({ from, to }: { from: string; to: string }) {
  if (hasEdge(from, to)) return <ArrowRight aria-label="feeds" className="size-3.5 shrink-0 text-neutral-600" />;
  // The lane can list a stage after the one it feeds (self-serve → closed).
  if (hasEdge(to, from)) return <ArrowLeft aria-label="fed by" className="size-3.5 shrink-0 text-neutral-600" />;
  return <Plus aria-label="and" className="size-3 shrink-0 text-neutral-700" />;
}

function LaneRow({ lane, endIds, allGoals }: { lane: GoalChain["lanes"][number]; endIds: Set<string>; allGoals: Goal[] }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <h3 className={cn("pt-1 text-xs font-medium", lane.goalCount > 0 ? "text-neutral-300" : "text-neutral-600")}>
        {lane.title}
        {lane.goalCount === 0 && <span className="block font-normal text-neutral-600">no goal</span>}
      </h3>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        {lane.stages.map((stage, i) => {
          const goals = lane.goalsByStage[stage.id] ?? [];
          return (
            <li key={stage.id} className="flex items-center gap-2">
              {i > 0 && <Connector from={lane.stages[i - 1].id} to={stage.id} />}
              {goals.length === 0 ? (
                <span className="rounded-md border border-dashed border-white/[0.08] px-2 py-1 text-[11px] text-neutral-600">
                  {stage.label}
                </span>
              ) : (
                <span className="flex flex-col gap-1.5">
                  {goals.map((g) => (
                    <GoalNode key={g.id} goal={g} label={goalLabel(g, allGoals)} isEnd={endIds.has(g.id)} />
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function GoalChainMap({ chain, allGoals }: { chain: GoalChain; allGoals: Goal[] }) {
  const entries = chain.lanes.filter((l) => l.id !== BAND_LANE_ID);
  const band = chain.lanes.find((l) => l.id === BAND_LANE_ID);
  return (
    <section aria-labelledby="goal-chain-title" className="mb-8 rounded-xl border border-white/[0.06] bg-neutral-950/60 px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="goal-chain-title" className="text-sm font-medium text-neutral-100">
          How the goals feed each other
        </h2>
        <p className="text-[11px] text-neutral-500">
          Funnel order, top to bottom. The tick on each bar is where it should be today.
        </p>
      </div>
      <div className="mt-2 divide-y divide-white/[0.04]">
        {entries.map((lane) => (
          <LaneRow key={lane.id} lane={lane} endIds={chain.endIds} allGoals={allGoals} />
        ))}
      </div>
      {band && (
        <>
          <div className="flex items-center gap-2 border-t border-white/[0.04] py-2 text-[11px] text-neutral-500 sm:pl-[8.75rem]">
            <ArrowDown aria-hidden className="size-3.5 text-neutral-600" />
            the entry lanes feed the commercial band
          </div>
          <div className="rounded-lg bg-white/[0.02] px-3">
            <LaneRow lane={band} endIds={chain.endIds} allGoals={allGoals} />
          </div>
        </>
      )}
    </section>
  );
}
