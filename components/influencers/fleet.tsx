"use client";

import { ChevronRight, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  Avatar,
  Dot,
  Empty,
  SectionLabel,
  Status,
  channelTone,
  cls,
  isChannelConnected,
  platformLabel,
  type Persona,
} from "./shared";

/**
 * The fleet as a roster, not a deck of cards: one row per persona, the things
 * that decide where to look next (drafts waiting, channels not wired) read
 * down a column. A row is a button; the whole row opens the persona.
 */
export function FleetRoster({
  personas,
  onOpen,
  onCreate,
}: {
  personas: Persona[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  if (personas.length === 0) {
    return (
      <Empty>
        <p>No personas yet.</p>
        <p className="mt-1 text-neutral-600">
          The wizard designs the character from a one-line niche; you edit everything before it exists, and it is born paused.
        </p>
        <button type="button" onClick={onCreate} className={cn(cls.primary, "mt-4")}>
          <Sparkles className="size-3.5" /> Create the first persona
        </button>
      </Empty>
    );
  }

  return (
    <section>
      <SectionLabel hint="Click a row to open the persona.">Fleet</SectionLabel>
      <div className={cn(cls.panel, "divide-y divide-white/[0.06]")}>
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,2.4fr)_112px_92px_20px] items-center gap-4 px-4 py-2 md:grid">
          <p className={cls.label}>Persona</p>
          <p className={cls.label}>Channels</p>
          <p className={cn(cls.label, "text-right")}>Waiting review</p>
          <p className={cls.label}>Status</p>
          <span />
        </div>
        {personas.map((p) => {
          const connected = p.channels.filter(isChannelConnected).length;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onOpen(p.id)}
              className="group grid w-full grid-cols-[minmax(0,1fr)_20px] items-center gap-4 px-4 py-3 text-left hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 md:grid-cols-[minmax(0,2fr)_minmax(0,2.4fr)_112px_92px_20px]"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar persona={p} size={36} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-100">{p.display_name}</p>
                  <p className="truncate text-xs text-neutral-500">
                    @{p.handle} · {p.beat}
                  </p>
                </div>
              </div>

              <div className="hidden min-w-0 flex-wrap items-center gap-x-3 gap-y-1 md:flex">
                {p.channels.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-1.5 text-xs text-neutral-400" title={c.status}>
                    <Dot tone={channelTone(c)} />
                    {platformLabel(c.platform)}
                  </span>
                ))}
                {p.channels.length === 0 ? <span className="text-xs text-neutral-600">no channels</span> : null}
              </div>

              <p
                className={cn(
                  "hidden text-right text-sm tabular-nums md:block",
                  p.pending_drafts > 0 ? "text-neutral-100" : "text-neutral-600",
                )}
              >
                {p.pending_drafts}
              </p>

              <div className="hidden md:block">
                <Status tone={p.status === "active" ? "good" : "muted"}>{p.status}</Status>
              </div>

              <ChevronRight className="size-4 text-neutral-600 group-hover:text-neutral-300" />

              <div className="col-span-2 flex items-center gap-3 text-xs text-neutral-500 md:hidden">
                <Status tone={p.status === "active" ? "good" : "muted"}>{p.status}</Status>
                <span>
                  {connected}/{p.channels.length} channels connected
                </span>
                <span>{p.pending_drafts} waiting review</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
