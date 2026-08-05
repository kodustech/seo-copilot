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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-4 pt-3">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setHalf(t.id)}
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

      {/* Both stay mounted-on-demand rather than always: each fetches its own
          data on mount, and the outbound side runs several aggregate queries
          that are not worth paying for when you came to look at traffic. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {half === "inbound" ? <Dashboard /> : <OutboundMetricsPage />}
      </div>
    </div>
  );
}
