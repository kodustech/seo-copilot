"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2, Pause, Play } from "lucide-react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ChannelsTab } from "./channels";
import { ModelTab } from "./model";
import { PlanTab } from "./plan";
import { ProfileTab } from "./profile";
import { RunsTab } from "./runs";
import {
  ACTIVITY_STATUS_LABEL,
  Avatar,
  Dot,
  Empty,
  SectionLabel,
  Status,
  activityTone,
  authHeaders,
  channelTone,
  cls,
  fmtDayFull,
  fmtTime,
  isChannelConnected,
  platformLabel,
  type Activity,
  type Persona,
} from "./shared";

const TABS = [
  { value: "plan", label: "Plan" },
  { value: "timeline", label: "Timeline" },
  { value: "runs", label: "Runs" },
  { value: "channels", label: "Channels" },
  { value: "model", label: "Model" },
  { value: "profile", label: "Profile" },
] as const;

/**
 * One persona as a bench: identity and the numbers on the left, the work on
 * the right. The tabs stay (they are the page's information architecture);
 * what changes is that the persona is in view while you work any of them.
 */
export function PersonaDetail({
  token,
  persona,
  onBack,
  onChanged,
}: {
  token: string;
  persona: Persona;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loadingActivities, setLoadingActivities] = useState(true);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadActivities = useCallback(async () => {
    setLoadingActivities(true);
    try {
      const res = await fetch(`/api/influencers/activities?persona_id=${persona.id}&limit=100`, { headers: authHeaders(token) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load the timeline");
      setActivities(body.activities ?? []);
      setDetailError(null);
    } catch (err) {
      setActivities([]);
      setDetailError(err instanceof Error ? err.message : "Failed to load the timeline");
    } finally {
      setLoadingActivities(false);
    }
  }, [token, persona.id]);

  useEffect(() => {
    loadActivities();
  }, [loadActivities]);

  async function toggleStatus() {
    setTogglingStatus(true);
    try {
      const res = await fetch(`/api/influencers/${persona.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ status: persona.status === "active" ? "paused" : "active" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to update status (${res.status})`);
      }
      setDetailError(null);
      onChanged();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setTogglingStatus(false);
    }
  }

  const weekAgo = useMemo(() => Date.now() - 7 * 24 * 60 * 60 * 1000, []);
  const publishedThisWeek = activities.filter((a) => a.status === "published" && new Date(a.published_at ?? a.created_at).getTime() >= weekAgo).length;
  const failed = activities.filter((a) => a.status === "failed").length;
  const connected = persona.channels.filter(isChannelConnected).length;

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className={cn(cls.ghost, "-ml-2.5")}>
        <ArrowLeft className="size-3.5" /> Fleet
      </button>

      {detailError ? <p className={cls.error}>{detailError}</p> : null}

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
          <div className="flex items-start gap-3">
            <Avatar persona={persona} size={56} />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold leading-tight text-neutral-100">{persona.display_name}</h2>
              <p className="truncate text-xs text-neutral-500">@{persona.handle}</p>
              <Status tone={persona.status === "active" ? "good" : "muted"} className="mt-1.5">
                {persona.status}
              </Status>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-neutral-400">{persona.beat}</p>
          <button type="button" disabled={togglingStatus} onClick={toggleStatus} className={cls.outline}>
            {togglingStatus ? <Loader2 className="size-3.5 animate-spin" /> : persona.status === "active" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {persona.status === "active" ? "Pause persona" : "Resume persona"}
          </button>

          <dl className={cn(cls.panel, "divide-y divide-white/[0.06] text-sm")}>
            <Stat label="Waiting review" value={persona.pending_drafts} tone={persona.pending_drafts > 0 ? "text-neutral-100" : "text-neutral-500"} />
            <Stat label="Published, 7 days" value={loadingActivities ? "…" : publishedThisWeek} />
            <Stat label="Failed to publish" value={loadingActivities ? "…" : failed} tone={failed > 0 ? "text-red-300" : "text-neutral-500"} />
            <Stat label="Channels connected" value={`${connected}/${persona.channels.length}`} />
          </dl>

          <div>
            <SectionLabel>Channels</SectionLabel>
            <ul className="space-y-1.5">
              {persona.channels.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-xs">
                  <Dot tone={channelTone(c)} />
                  <span className="text-neutral-300">{platformLabel(c.platform)}</span>
                  <span className="ml-auto text-neutral-600">{c.status === "active" ? (c.publish_via === "manual" ? "by hand" : c.automation_level === "auto" ? "auto" : "review") : c.status === "paused" ? "paused" : "set up"}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <Tabs defaultValue="timeline" className="min-w-0 gap-4">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-none border-b border-white/[0.06] bg-transparent p-0">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="-mb-px flex-none rounded-none border-0 border-b-2 border-transparent px-3 py-2 text-xs text-neutral-500 shadow-none data-[state=active]:border-violet-400 data-[state=active]:bg-transparent data-[state=active]:text-neutral-100 data-[state=active]:shadow-none dark:data-[state=active]:border-b-violet-400 dark:data-[state=active]:bg-transparent"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="plan">
            <PlanTab token={token} persona={persona} />
          </TabsContent>
          <TabsContent value="timeline">
            <Timeline persona={persona} activities={activities} loading={loadingActivities} />
          </TabsContent>
          <TabsContent value="runs">
            <RunsTab token={token} persona={persona} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="channels">
            <ChannelsTab token={token} channels={persona.channels} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="model">
            <ModelTab token={token} persona={persona} />
          </TabsContent>
          <TabsContent value="profile">
            <ProfileTab persona={persona} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between px-3 py-2">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className={cn("tabular-nums", tone ?? "text-neutral-200")}>{value}</dd>
    </div>
  );
}

/**
 * The timeline as a ledger grouped by day. Time, state, channel, then the
 * text; a row expands on click. The feed lane the draft came from stays off
 * the row: it read as a channel and was not one.
 */
function Timeline({ persona, activities, loading }: { persona: Persona; activities: Activity[]; loading: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const channelById = useMemo(() => new Map(persona.channels.map((c) => [c.id, c])), [persona.channels]);

  const groups = useMemo(() => {
    const m = new Map<string, Activity[]>();
    for (const a of activities) {
      const when = a.published_at ?? a.created_at;
      const key = new Date(when).toDateString();
      m.set(key, [...(m.get(key) ?? []), a]);
    }
    return [...m.entries()];
  }, [activities]);

  if (loading) return <Skeleton className="h-24 bg-white/[0.04]" />;
  if (activities.length === 0) {
    return <Empty>Nothing yet. Turn autonomy on in the Plan tab, or run a shift now, and drafts start landing here.</Empty>;
  }

  return (
    <section>
      <SectionLabel hint={`${activities.length} most recent`}>Timeline</SectionLabel>
      <div className={cn(cls.panel, "divide-y divide-white/[0.06]")}>
        {groups.map(([day, items]) => (
          <div key={day}>
            <p className="bg-neutral-950/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500">{fmtDayFull(items[0].published_at ?? items[0].created_at)}</p>
            <ul className="divide-y divide-white/[0.04]">
              {items.map((a) => {
                const channel = channelById.get(a.channel_id);
                const open = openId === a.id;
                const when = a.published_at ?? a.created_at;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : a.id)}
                      className="grid w-full grid-cols-[52px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 md:grid-cols-[52px_96px_110px_minmax(0,1fr)]"
                    >
                      <span className="pt-0.5 text-[11px] tabular-nums text-neutral-500">{fmtTime(when)}</span>
                      <Status tone={activityTone(a.status)} className="pt-0.5">
                        {ACTIVITY_STATUS_LABEL[a.status]}
                      </Status>
                      <span className="col-start-2 text-xs text-neutral-400 md:col-start-3 md:pt-0.5">
                        {channel ? platformLabel(channel.platform) : "?"}
                        <span className="text-neutral-600"> · {a.kind}</span>
                      </span>
                      <span className={cn("col-span-2 min-w-0 text-sm leading-relaxed text-neutral-200 md:col-span-1", !open && "line-clamp-2")}>
                        {a.title ? <span className="font-medium text-neutral-100">{a.title} </span> : null}
                        <span className={cn(a.title && !open && "text-neutral-400")}>{a.content}</span>
                      </span>
                    </button>
                    {open ? (
                      <div className="flex flex-wrap items-center gap-3 px-4 pb-3 pl-[64px] text-xs text-neutral-500 md:pl-[286px]">
                        {a.external_url ? (
                          <a href={a.external_url} target="_blank" rel="noreferrer" className={cn(cls.link, "inline-flex items-center gap-1")}>
                            <ExternalLink className="size-3" /> View post
                          </a>
                        ) : null}
                        {a.scheduled_at && a.status === "scheduled" ? <span>Scheduled for {fmtDayFull(a.scheduled_at)} {fmtTime(a.scheduled_at)}</span> : null}
                        {a.error ? <span className="text-red-300">{a.error}</span> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
