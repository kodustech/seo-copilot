"use client";

/* Hallmark · genre: modern-minimal · macrostructure: Workbench (app page: fleet roster + persona bench) · theme: app tokens (dark neutral, violet ≤ 5%) · enrichment: none · nav: app shell · footer: none */

import { useCallback, useEffect, useState } from "react";
import { Bot, Plus, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

import { FleetRoster } from "./influencers/fleet";
import { PersonaDetail } from "./influencers/persona-detail";
import { ReviewQueue } from "./influencers/queue";
import { SectionLabel, Segmented, authHeaders, cls, isChannelConnected, useAuthToken, type Persona } from "./influencers/shared";
import { WizardDialog } from "./influencers/wizard";

type View = "queue" | "fleet";

export function InfluencersPage() {
  const token = useAuthToken();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [view, setView] = useState<View>("queue");

  const loadFleet = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/influencers", { headers: authHeaders(token) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load personas");
      setPersonas(body.personas ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load personas");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadFleet();
  }, [loadFleet]);

  const selected = personas.find((p) => p.id === selectedId) ?? null;
  const pending = personas.reduce((n, p) => n + p.pending_drafts, 0);
  const activePersonas = personas.filter((p) => p.status === "active").length;
  const channels = personas.flatMap((p) => p.channels);
  const connected = channels.filter(isChannelConnected).length;
  const needSetup = channels.filter((c) => c.status === "pending_setup").length;

  if (!token || loading) {
    return (
      <div className={cls.page}>
        <Skeleton className="h-8 w-64 bg-white/[0.04]" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-20 bg-white/[0.04]" />
          <Skeleton className="h-20 bg-white/[0.04]" />
          <Skeleton className="h-20 bg-white/[0.04]" />
          <Skeleton className="h-20 bg-white/[0.04]" />
        </div>
        <Skeleton className="h-40 bg-white/[0.04]" />
      </div>
    );
  }

  return (
    <div className={cls.page}>
      {selected ? (
        <PersonaDetail token={token} persona={selected} onBack={() => setSelectedId(null)} onChanged={loadFleet} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-xl font-semibold text-neutral-100">
                <Bot className="size-5 text-violet-400" /> Influencers
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-neutral-400">
                A fleet of AI personas that draft on their own shifts. Nothing goes on the wire outside a channel&apos;s rules, and until a channel earns auto, nothing goes without your approval.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<View>
                value={view}
                onChange={setView}
                options={[
                  { value: "queue", label: pending > 0 ? `Queue · ${pending}` : "Queue" },
                  { value: "fleet", label: `Fleet · ${personas.length}` },
                ]}
              />
              <button type="button" onClick={() => loadFleet()} title="Reload" aria-label="Reload" className={cls.iconBtn}>
                <RefreshCw className="size-3.5" />
              </button>
              <button type="button" onClick={() => setWizardOpen(true)} className={cls.primary}>
                <Plus className="size-3.5" /> New influencer
              </button>
            </div>
          </div>

          {error ? <p className={cls.error}>{error}</p> : null}

          <section>
            <SectionLabel hint="The fleet right now.">Reading</SectionLabel>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "Active personas", value: activePersonas, note: `${personas.length - activePersonas} paused` },
                { label: "Waiting for review", value: pending, note: "drafts in the queue", tone: pending ? "text-neutral-100" : "" },
                { label: "Channels connected", value: connected, note: `of ${channels.length}` },
                { label: "Channels to set up", value: needSetup, note: needSetup ? "open the persona to connect" : "all wired", tone: needSetup ? "text-amber-300" : "" },
              ].map((c) => (
                <div key={c.label} className={cn(cls.panel, "p-4")}>
                  <p className={cls.label}>{c.label}</p>
                  <p className={cn("mt-1 text-3xl font-semibold tabular-nums tracking-tight text-neutral-100", c.tone)}>{c.value}</p>
                  <p className="text-[11px] text-neutral-500">{c.note}</p>
                </div>
              ))}
            </div>
          </section>

          {view === "queue" ? (
            <ReviewQueue token={token} personas={personas} onChanged={loadFleet} />
          ) : (
            <FleetRoster personas={personas} onOpen={setSelectedId} onCreate={() => setWizardOpen(true)} />
          )}
        </>
      )}

      <WizardDialog
        token={token}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => {
          setWizardOpen(false);
          loadFleet();
        }}
      />
    </div>
  );
}
