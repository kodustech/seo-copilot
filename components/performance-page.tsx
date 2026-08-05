"use client";

// ---------------------------------------------------------------------------
// One Performance screen for both halves of the funnel.
//
// They used to be two nav entries in two different groups — "Performance" under
// Attract and "Outbound perf" under Convert — which meant answering "how are we
// doing" required knowing in advance which motion you were asking about, and
// comparing them meant holding one page in your head while looking at the other.
//
// Deliberately tabs rather than a merged set of numbers. Inbound counts
// sessions and impressions; outbound counts sends and replies. There is no
// honest single funnel over the two — a combined "conversion rate" would be
// dividing by a denominator that mixes a search impression with an email — so
// this puts them one click apart and leaves the arithmetic alone.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { BarChart3, Send } from "lucide-react";

import { Dashboard } from "@/components/dashboard";
import { OutboundMetricsPage } from "@/components/outbound-metrics-page";
import { cn } from "@/lib/utils";

type Half = "inbound" | "outbound";

const TABS: { id: Half; label: string; hint: string; icon: typeof BarChart3 }[] = [
  {
    id: "inbound",
    label: "Inbound",
    hint: "Content, search and traffic",
    icon: BarChart3,
  },
  {
    id: "outbound",
    label: "Outbound",
    hint: "Sends, replies and the sequence funnel",
    icon: Send,
  },
];

export function PerformancePage() {
  const [half, setHalf] = useState<Half>("inbound");
  // Mount on first visit, then keep mounted and swap with CSS.
  //
  // Conditional rendering alone unmounts the half you are leaving, so every
  // toggle threw away the period selector on one side and the days/sequence
  // filters on the other, and re-ran the outbound aggregate queries from
  // scratch — comparing the two halves meant losing your filters each way.
  // Rendering both from the start would fix that and pay for the outbound
  // aggregates for everyone who came to look at traffic. Lazy-mount-then-keep
  // is the only option that avoids both.
  const [seen, setSeen] = useState<Set<Half>>(() => new Set<Half>(["inbound"]));

  function show(next: Half) {
    setHalf(next);
    setSeen((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-4 pt-3">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => show(t.id)}
              title={t.hint}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 pb-2 text-sm transition-colors",
                half === t.id
                  ? "border-white text-neutral-100"
                  : "border-transparent text-neutral-500 hover:text-neutral-300",
              )}
            >
              <Icon className="size-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* `hidden` rather than unmounting: the inactive half keeps its filters
            and its already-fetched data. Each is only mounted once visited, so
            the outbound aggregates are never run for someone who came to look
            at traffic and never opened that tab. */}
        {seen.has("inbound") ? (
          <div className={cn(half !== "inbound" && "hidden")}>
            <Dashboard />
          </div>
        ) : null}
        {seen.has("outbound") ? (
          <div className={cn(half !== "outbound" && "hidden")}>
            <OutboundMetricsPage />
          </div>
        ) : null}
      </div>
    </div>
  );
}
