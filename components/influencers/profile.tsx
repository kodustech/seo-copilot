"use client";

import { cn } from "@/lib/utils";

import { cls, type Persona } from "./shared";

/** Who the persona is, as a reading: label above, text below, one column. */
export function ProfileTab({ persona }: { persona: Persona }) {
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Bio", value: persona.bio },
    {
      label: "AI disclosure",
      value: persona.disclosure ? (
        persona.disclosure
      ) : (
        <span className="text-neutral-500">Not disclosing. Medium shows undisclosed AI writing to followers only; the persona can still add a line per page.</span>
      ),
    },
    { label: "Backstory and worldview", value: persona.backstory },
    { label: "Tone", value: persona.tone ?? <span className="text-neutral-500">Not set</span> },
    {
      label: "Writing guidelines",
      value: persona.writing_guidelines ?? <span className="text-neutral-500">Not set</span>,
    },
    {
      label: "Never talks about",
      value: persona.forbidden_topics.length ? (
        <div className="flex flex-wrap gap-1.5">
          {persona.forbidden_topics.map((t) => (
            <span key={t} className={cls.chip}>
              {t}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-neutral-500">Nothing forbidden</span>
      ),
    },
  ];

  return (
    <div className={cn(cls.panel, "divide-y divide-white/[0.06]")}>
      {rows.map((r) => (
        <div key={r.label} className="grid gap-1 px-4 py-3 md:grid-cols-[180px_minmax(0,1fr)] md:gap-6">
          <p className={cn(cls.label, "md:pt-0.5")}>{r.label}</p>
          <div className="text-sm leading-relaxed text-neutral-200">{r.value}</div>
        </div>
      ))}
    </div>
  );
}
