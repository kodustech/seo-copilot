"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  Loader2,
  Pause,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type Channel = {
  id: string;
  persona_id: string;
  platform: "x" | "devto" | "blog" | "medium" | "reddit" | "hackernews";
  external_handle: string | null;
  publish_via: string;
  automation_level: "auto" | "approve_first" | "draft_only";
  max_posts_per_day: number;
  max_replies_per_day: number;
  credentials_ref: string | null;
  channel_config: Record<string, unknown>;
  onboarding: Record<string, boolean>;
  status: "pending_setup" | "active" | "paused";
};

type Persona = {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  backstory: string;
  disclosure: string | null;
  beat: string;
  tone: string | null;
  writing_guidelines: string | null;
  forbidden_topics: string[];
  status: "active" | "paused";
  channels: Channel[];
  pending_drafts: number;
};

type Activity = {
  id: string;
  persona_id: string;
  channel_id: string;
  kind: string;
  status:
    | "draft"
    | "approved"
    | "scheduled"
    | "publishing"
    | "published"
    | "failed"
    | "discarded";
  title: string | null;
  content: string;
  content_meta: Record<string, unknown>;
  source_ref: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  external_url: string | null;
  error: string | null;
  created_at: string;
};

type Proposal = {
  handle: string;
  display_name: string;
  bio: string;
  backstory: string;
  disclosure: string;
  beat: string;
  tone: string;
  writing_guidelines: string;
  preferred_words: string[];
  forbidden_words: string[];
  allowed_topics: string[];
  forbidden_topics: string[];
  avatar_prompt: string;
  avatar_url: string | null;
};

const STATUS_BADGE: Record<Activity["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  scheduled: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  publishing: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  published:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  discarded: "bg-muted text-muted-foreground line-through",
};

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  return token;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function Avatar({ persona, size }: { persona: Persona; size: number }) {
  if (persona.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={persona.avatar_url}
        alt={persona.display_name}
        width={size}
        height={size}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded-full bg-muted flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <Bot className="h-1/2 w-1/2 text-muted-foreground" />
    </div>
  );
}

export function InfluencersPage() {
  const token = useAuthToken();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

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

  if (!token || loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Influencers</h1>
          <p className="text-sm text-muted-foreground max-w-xl">
            A fleet of openly-AI personas. They draft daily; nothing goes on the
            wire without passing the per-channel rules — and, until a channel
            earns auto, without your approval.
          </p>
        </div>
        <Button onClick={() => setWizardOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Create influencer
        </Button>
      </div>

      {error && (
        <div className="text-sm text-red-600 border border-red-200 rounded-md p-3">
          {error}
        </div>
      )}

      {selected ? (
        <PersonaDetail
          token={token}
          persona={selected}
          onBack={() => setSelectedId(null)}
          onChanged={loadFleet}
        />
      ) : (
        <Tabs defaultValue="queue">
          <TabsList>
            <TabsTrigger value="queue">
              Review queue
              {personas.reduce((n, p) => n + p.pending_drafts, 0) > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {personas.reduce((n, p) => n + p.pending_drafts, 0)}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="fleet">Fleet ({personas.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="queue" className="mt-4">
            <ReviewQueue token={token} personas={personas} onChanged={loadFleet} />
          </TabsContent>

          <TabsContent value="fleet" className="mt-4">
            {personas.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center space-y-3">
                  <Bot className="h-10 w-10 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No personas yet. Create the first one — the wizard designs
                    the character and you polish it before anything goes live.
                  </p>
                  <Button onClick={() => setWizardOpen(true)}>
                    <Sparkles className="h-4 w-4 mr-1" /> Create the first persona
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {personas.map((persona) => (
                  <Card
                    key={persona.id}
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => setSelectedId(persona.id)}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-center gap-3">
                        <Avatar persona={persona} size={44} />
                        <div className="min-w-0">
                          <CardTitle className="text-base truncate">
                            {persona.display_name}
                          </CardTitle>
                          <p className="text-xs text-muted-foreground truncate">
                            @{persona.handle} · {persona.beat}
                          </p>
                        </div>
                        <Badge
                          variant={persona.status === "active" ? "default" : "secondary"}
                          className="ml-auto shrink-0"
                        >
                          {persona.status}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {persona.bio}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {persona.channels.map((ch) => (
                          <Badge key={ch.id} variant="outline" className="text-[10px]">
                            {ch.platform}
                            {ch.status !== "active" ? ` · ${ch.status}` : ""}
                          </Badge>
                        ))}
                      </div>
                      {persona.pending_drafts > 0 && (
                        <p className="text-xs">
                          <span className="font-medium">{persona.pending_drafts}</span>{" "}
                          drafts waiting for review
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
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

// ---------------------------------------------------------------------------
// Review queue (unified across personas)
// ---------------------------------------------------------------------------

function ReviewQueue({
  token,
  personas,
  onChanged,
}: {
  token: string;
  personas: Persona[];
  onChanged: () => void;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [personaFilter, setPersonaFilter] = useState<string>("all");
  const personaById = useMemo(
    () => new Map(personas.map((p) => [p.id, p])),
    [personas],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: "draft,failed", limit: "100" });
      if (personaFilter !== "all") params.set("persona_id", personaFilter);
      const res = await fetch(`/api/influencers/activities?${params}`, {
        headers: authHeaders(token),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load the queue");
      setActivities(body.activities ?? []);
      setError(null);
    } catch (err) {
      setActivities([]);
      setError(err instanceof Error ? err.message : "Failed to load the queue");
    } finally {
      setLoading(false);
    }
  }, [token, personaFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function review(
    id: string,
    action: "approve" | "discard",
    content?: string,
  ) {
    const res = await fetch(`/api/influencers/activities/${id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ action, ...(content ? { content } : {}) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to ${action} (${res.status})`);
    }
    setActivities((prev) => prev.filter((a) => a.id !== id));
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={personaFilter} onValueChange={setPersonaFilter}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="All personas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All personas</SelectItem>
            {personas.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                @{p.handle}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {error && (
        <div className="text-sm text-red-600 border border-red-200 rounded-md p-3">
          {error}
        </div>
      )}

      {!loading && !error && activities.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Queue is clear. New drafts land daily at 10:00 UTC for every active
            persona.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {activities.map((activity) => (
            <QueueItem
              key={activity.id}
              activity={activity}
              persona={personaById.get(activity.persona_id)}
              onReview={review}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueItem({
  activity,
  persona,
  onReview,
}: {
  activity: Activity;
  persona: Persona | undefined;
  onReview: (
    id: string,
    action: "approve" | "discard",
    content?: string,
  ) => Promise<void>;
}) {
  const [content, setContent] = useState(activity.content);
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const edited = content.trim() !== activity.content;
  const lane =
    typeof activity.content_meta.lane === "string"
      ? activity.content_meta.lane
      : null;

  async function act(action: "approve" | "discard") {
    setBusy(action);
    setActionError(null);
    try {
      await onReview(activity.id, action, edited ? content.trim() : undefined);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `Failed to ${action}`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <span className="font-medium text-foreground">
            @{persona?.handle ?? "?"}
          </span>
          {lane && <Badge variant="outline">{lane}</Badge>}
          <Badge className={STATUS_BADGE[activity.status]}>{activity.status}</Badge>
          {activity.source_ref && (
            <a
              href={activity.source_ref}
              target="_blank"
              rel="noreferrer"
              className="underline truncate max-w-[16rem]"
            >
              source
            </a>
          )}
          <span className="ml-auto">
            {new Date(activity.created_at).toLocaleString()}
          </span>
        </div>

        {activity.error && (
          <p className="text-xs text-red-600">{activity.error}</p>
        )}
        {actionError && <p className="text-xs text-red-600">{actionError}</p>}

        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={3}
          className="text-sm"
        />

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy !== null || !content.trim()}
            onClick={() => act("approve")}
          >
            {busy === "approve" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-1" />
            )}
            {edited ? "Save & approve" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act("discard")}
          >
            {busy === "discard" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 mr-1" />
            )}
            Discard
          </Button>
          <span className="text-xs text-muted-foreground ml-auto">
            {content.trim().length}/280
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Persona detail: timeline + profile + channels
// ---------------------------------------------------------------------------

function PersonaDetail({
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
      const res = await fetch(
        `/api/influencers/activities?persona_id=${persona.id}&limit=100`,
        { headers: authHeaders(token) },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load the timeline");
      setActivities(body.activities ?? []);
      setDetailError(null);
    } catch (err) {
      setActivities([]);
      setDetailError(
        err instanceof Error ? err.message : "Failed to load the timeline",
      );
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
        body: JSON.stringify({
          status: persona.status === "active" ? "paused" : "active",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to update status (${res.status})`);
      }
      setDetailError(null);
      onChanged();
    } catch (err) {
      setDetailError(
        err instanceof Error ? err.message : "Failed to update status",
      );
    } finally {
      setTogglingStatus(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Fleet
        </Button>
        <Avatar persona={persona} size={40} />
        <div className="min-w-0">
          <h2 className="font-semibold leading-tight">{persona.display_name}</h2>
          <p className="text-xs text-muted-foreground">
            @{persona.handle} · {persona.beat}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={persona.status === "active" ? "default" : "secondary"}>
            {persona.status}
          </Badge>
          <Button
            size="sm"
            variant={persona.status === "active" ? "destructive" : "default"}
            disabled={togglingStatus}
            onClick={toggleStatus}
          >
            {togglingStatus ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : persona.status === "active" ? (
              <>
                <Pause className="h-4 w-4 mr-1" /> Pause persona
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-1" /> Activate persona
              </>
            )}
          </Button>
        </div>
      </div>

      {detailError && (
        <div className="text-sm text-red-600 border border-red-200 rounded-md p-3">
          {detailError}
        </div>
      )}

      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="model">Model</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>

        <TabsContent value="plan" className="mt-4">
          <PlanTab token={token} persona={persona} />
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <RunsTab token={token} persona={persona} onChanged={onChanged} />
        </TabsContent>

        <TabsContent value="model" className="mt-4">
          <ModelTab token={token} persona={persona} />
        </TabsContent>

        <TabsContent value="timeline" className="mt-4 space-y-3">
          {loadingActivities ? (
            <Skeleton className="h-24" />
          ) : activities.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Nothing yet. Turn on autonomy (or hit “Act now”) in the Plan
                tab and drafts start landing after its next shift.
              </CardContent>
            </Card>
          ) : (
            activities.map((activity) => (
              <Card key={activity.id}>
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <Badge className={STATUS_BADGE[activity.status]}>
                      {activity.status}
                    </Badge>
                    <Badge variant="outline">{activity.kind}</Badge>
                    {typeof activity.content_meta.lane === "string" && (
                      <Badge variant="outline">{activity.content_meta.lane}</Badge>
                    )}
                    {activity.external_url && (
                      <a
                        href={activity.external_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        view post
                      </a>
                    )}
                    <span className="ml-auto">
                      {new Date(
                        activity.published_at ?? activity.created_at,
                      ).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{activity.content}</p>
                  {activity.error && (
                    <p className="text-xs text-red-600">{activity.error}</p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="channels" className="mt-4 space-y-3">
          {persona.channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              token={token}
              channel={channel}
              onChanged={onChanged}
            />
          ))}
        </TabsContent>

        <TabsContent value="profile" className="mt-4">
          <Card>
            <CardContent className="pt-4 space-y-4 text-sm">
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground mb-1">
                  Bio
                </p>
                <p>{persona.bio}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground mb-1">
                  AI disclosure
                </p>
                <p>{persona.disclosure ?? "— (not disclosing)"}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground mb-1">
                  Backstory / worldview
                </p>
                <p className="whitespace-pre-wrap">{persona.backstory}</p>
              </div>
              {persona.tone && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground mb-1">
                    Tone
                  </p>
                  <p>{persona.tone}</p>
                </div>
              )}
              {persona.forbidden_topics.length > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground mb-1">
                    Never talks about
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {persona.forbidden_topics.map((topic) => (
                      <Badge key={topic} variant="outline">
                        {topic}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ChannelCard({
  token,
  channel,
  onChanged,
}: {
  token: string;
  channel: Channel;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [handle, setHandle] = useState(channel.external_handle ?? "");
  const isDraftOnly = channel.automation_level === "draft_only";

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to save (${res.status})`);
      }
      setSaveError(null);
      onChanged();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm uppercase">{channel.platform}</CardTitle>
          <Badge variant={channel.status === "active" ? "default" : "secondary"}>
            {channel.status}
          </Badge>
          <Badge variant="outline">{channel.automation_level}</Badge>
          {saving && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
          {channel.status === "active" ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={saving}
              onClick={() => patch({ status: "paused" })}
            >
              Pause
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={saving}
              onClick={() => patch({ status: "active" })}
            >
              Activate
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {saveError && <p className="text-xs text-red-600">{saveError}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Platform handle</p>
            <Input
              value={handle}
              placeholder="@handle"
              onChange={(event) => setHandle(event.target.value)}
              onBlur={() => {
                if ((channel.external_handle ?? "") !== handle) {
                  patch({ external_handle: handle || null });
                }
              }}
            />
          </div>
          {!isDraftOnly && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Automation</p>
              <Select
                value={channel.automation_level}
                onValueChange={(value) => patch({ automation_level: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approve_first">
                    approve_first — human reviews everything
                  </SelectItem>
                  <SelectItem value="auto">
                    auto — publishes without review (earn it first)
                  </SelectItem>
                  <SelectItem value="draft_only">
                    draft_only — tool never publishes
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {!isDraftOnly && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Posts/day</p>
                <Input
                  type="number"
                  min={0}
                  defaultValue={channel.max_posts_per_day}
                  onBlur={(event) =>
                    patch({ max_posts_per_day: Number(event.target.value) })
                  }
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Replies/day</p>
                <Input
                  type="number"
                  min={0}
                  defaultValue={channel.max_replies_per_day}
                  onBlur={(event) =>
                    patch({ max_replies_per_day: Number(event.target.value) })
                  }
                />
              </div>
            </div>
          )}
        </div>

        {isDraftOnly && (
          <p className="text-xs text-muted-foreground">
            This channel is draft-only by design: the tool drafts, a human posts
            from their own account. It never gets promoted to auto.
          </p>
        )}

        <Separator />
        <ChannelConnect token={token} channel={channel} onChanged={onChanged} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Real per-channel connect: Post-Bridge account picker (X, …) or a dev.to key.
// Replaces the old manual onboarding checklist.
// ---------------------------------------------------------------------------

type SocialAccount = { id: number; platform: string; username: string };

function ConnectShell({
  status,
  children,
}: {
  status: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Connection
        </p>
        <Badge variant={status === "connected" ? "default" : "secondary"}>
          {status}
        </Badge>
      </div>
      {children}
    </div>
  );
}

function ChannelConnect({
  token,
  channel,
  onChanged,
}: {
  token: string;
  channel: Channel;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}/connect`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not connect");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}/connect`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not disconnect");
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  // Post-Bridge platforms (X, …): pick from the accounts already linked there.
  if (channel.publish_via === "post_bridge") {
    return (
      <PostBridgeConnect
        token={token}
        channel={channel}
        busy={busy}
        error={error}
        onConnect={(accountId) => connect({ post_bridge_account_id: accountId })}
        onDisconnect={disconnect}
      />
    );
  }

  // dev.to: paste a personal API key; we validate it against dev.to.
  if (channel.platform === "devto") {
    return (
      <DevtoConnect
        channel={channel}
        busy={busy}
        error={error}
        onConnect={(apiKey) => connect({ api_key: apiKey })}
        onDisconnect={disconnect}
      />
    );
  }

  // aicodereview.io: publishes via the content API keyed by CONTENT_API_KEY.
  if (channel.platform === "blog") {
    return (
      <BlogConnect
        channel={channel}
        busy={busy}
        error={error}
        onConnect={() => connect({})}
        onDisconnect={disconnect}
      />
    );
  }

  // No direct publishing integration — the tool drafts, a human posts.
  return (
    <ConnectShell status="draft-only">
      <p className="text-xs text-muted-foreground">
        No direct publishing integration for {channel.platform} yet — the persona
        drafts here and a human posts from their own account.
      </p>
    </ConnectShell>
  );
}

function PostBridgeConnect({
  token,
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  token: string;
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: (accountId: number) => void;
  onDisconnect: () => void;
}) {
  const connectedId = channel.channel_config.post_bridge_account_id
    ? Number(channel.channel_config.post_bridge_account_id)
    : null;
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string>("");
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/influencers/channels/social-accounts?platform=${channel.platform}`, {
      headers: authHeaders(token),
    })
      .then((r) => r.json())
      .then((body) => {
        if (!active) return;
        setAccounts(body.accounts ?? []);
        setWarning(body.warning ?? null);
      })
      .catch(() => active && setWarning("Could not reach Post-Bridge."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [token, channel.platform]);

  const connectedAccount = accounts.find((a) => a.id === connectedId);

  if (connectedId) {
    return (
      <ConnectShell status="connected">
        <p className="text-xs text-muted-foreground">
          Posting via Post-Bridge as{" "}
          <span className="font-medium">
            {connectedAccount ? `@${connectedAccount.username}` : `account #${connectedId}`}
          </span>
          .
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <Button size="sm" variant="outline" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>
      </ConnectShell>
    );
  }

  return (
    <ConnectShell status="not connected">
      <p className="text-xs text-muted-foreground">
        Pick the Post-Bridge account this persona posts as. Don’t see it? Link
        the account in Post-Bridge first, then reload.
      </p>
      <div className="flex items-center gap-2">
        <Select value={picked} onValueChange={setPicked} disabled={loading || busy}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder={loading ? "Loading accounts…" : "Choose an account"} />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                @{a.username} · {a.platform}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={busy || !picked}
          onClick={() => onConnect(Number(picked))}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
        </Button>
      </div>
      {!loading && accounts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No {channel.platform} accounts found in Post-Bridge.
        </p>
      )}
      {warning && <p className="text-xs text-amber-600">{warning}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </ConnectShell>
  );
}

function DevtoConnect({
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: (apiKey: string) => void;
  onDisconnect: () => void;
}) {
  const connected = channel.credentials_ref?.startsWith("vault") ?? false;
  const [key, setKey] = useState("");

  if (connected) {
    return (
      <ConnectShell status="connected">
        <p className="text-xs text-muted-foreground">
          A dev.to API key is linked (stored encrypted). Articles publish to this
          account.
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <Button size="sm" variant="outline" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>
      </ConnectShell>
    );
  }

  return (
    <ConnectShell status="not connected">
      <p className="text-xs text-muted-foreground">
        Paste a dev.to API key (Settings → Extensions → “DEV Community API Keys”).
        We validate it and store it encrypted.
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={key}
          placeholder="dev.to API key"
          className="w-64"
          onChange={(e) => setKey(e.target.value)}
        />
        <Button size="sm" disabled={busy || !key.trim()} onClick={() => onConnect(key.trim())}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </ConnectShell>
  );
}

function BlogConnect({
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected =
    channel.credentials_ref?.startsWith("env:") || channel.status === "active";

  if (connected) {
    return (
      <ConnectShell status="connected">
        <p className="text-xs text-muted-foreground">
          Publishing long-form articles to aicodereview.io via its content API.
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <Button size="sm" variant="outline" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>
      </ConnectShell>
    );
  }

  return (
    <ConnectShell status="not connected">
      <p className="text-xs text-muted-foreground">
        Publishes to aicodereview.io using the workspace CONTENT_API_KEY. Connect
        to activate — if the key isn’t set, you’ll get told to set it first.
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onConnect}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </ConnectShell>
  );
}

// ---------------------------------------------------------------------------
// Creation wizard
// ---------------------------------------------------------------------------

function WizardDialog({
  token,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [direction, setDirection] = useState("");
  const [objective, setObjective] = useState("");
  const [language, setLanguage] = useState("en-US");
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/influencers/wizard", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ direction, objective, language }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Generation failed");
      setProposal(body.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function create() {
    if (!proposal) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          ...proposal,
          content_config: { language },
          channels: [
            { platform: "x" },
            { platform: "devto" },
            { platform: "reddit" },
            { platform: "hackernews" },
          ],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Creation failed");
      setProposal(null);
      setDirection("");
      setObjective("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Creation failed");
    } finally {
      setCreating(false);
    }
  }

  function updateProposal<K extends keyof Proposal>(key: K, value: Proposal[K]) {
    setProposal((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create influencer</DialogTitle>
          <DialogDescription>
            Describe the niche; the wizard designs an openly-AI character. You
            edit everything before it exists, and it is born paused.
          </DialogDescription>
        </DialogHeader>

        {!proposal ? (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Niche / direction *
              </p>
              <Textarea
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
                placeholder='e.g. "a grumpy staff engineer obsessed with code review quality and skeptical of AI hype"'
                rows={3}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Marketing objective (optional)
              </p>
              <Input
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="e.g. awareness for AI code review, links to aicodereview.io"
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Content language</p>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en-US">English</SelectItem>
                  <SelectItem value="pt-BR">Português</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <DialogFooter>
              <Button disabled={generating || !direction.trim()} onClick={generate}>
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" /> Designing…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-1" /> Design persona
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {proposal.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={proposal.avatar_url}
                  alt="avatar"
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
                  <Bot className="h-8 w-8 text-muted-foreground" />
                </div>
              )}
              <div className="grid gap-2 flex-1 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Name</p>
                  <Input
                    value={proposal.display_name}
                    onChange={(event) =>
                      updateProposal("display_name", event.target.value)
                    }
                  />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Handle</p>
                  <Input
                    value={proposal.handle}
                    onChange={(event) => updateProposal("handle", event.target.value)}
                  />
                </div>
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Beat</p>
              <Input
                value={proposal.beat}
                onChange={(event) => updateProposal("beat", event.target.value)}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Bio</p>
              <Textarea
                value={proposal.bio}
                onChange={(event) => updateProposal("bio", event.target.value)}
                rows={2}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                AI disclosure (optional — leave blank to not disclose)
              </p>
              <Input
                value={proposal.disclosure}
                onChange={(event) => updateProposal("disclosure", event.target.value)}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Backstory / worldview
              </p>
              <Textarea
                value={proposal.backstory}
                onChange={(event) => updateProposal("backstory", event.target.value)}
                rows={4}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Tone</p>
              <Textarea
                value={proposal.tone}
                onChange={(event) => updateProposal("tone", event.target.value)}
                rows={2}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Forbidden topics (comma-separated)
              </p>
              <Input
                value={proposal.forbidden_topics.join(", ")}
                onChange={(event) =>
                  updateProposal(
                    "forbidden_topics",
                    event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                disabled={creating}
                onClick={() => setProposal(null)}
              >
                <X className="h-4 w-4 mr-1" /> Start over
              </Button>
              <Button disabled={creating} onClick={create}>
                {creating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" /> Creating…
                  </>
                ) : (
                  "Create persona (paused)"
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Model tab: per-persona provider/model/endpoint + bring-your-own key
// ---------------------------------------------------------------------------

type ModelProviderOption =
  | ""
  | "kimi"
  | "google"
  | "openai"
  | "anthropic"
  | "openai_compatible"
  | "anthropic_compatible";

const PROVIDER_LABELS: Record<Exclude<ModelProviderOption, "">, string> = {
  kimi: "Kimi (Moonshot)",
  google: "Google (Gemini)",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openai_compatible: "OpenAI-compatible endpoint",
  anthropic_compatible: "Anthropic-compatible endpoint",
};

type CredentialMeta = {
  provider: string;
  key_last4: string;
  label: string | null;
  status: string;
  created_at: string;
};

function ModelTab({ token, persona }: { token: string; persona: Persona }) {
  const [provider, setProvider] = useState<ModelProviderOption>("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isCustom =
    provider === "openai_compatible" || provider === "anthropic_compatible";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/model`, {
        headers: authHeaders(token),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load model config");
      setProvider((body.model_provider ?? "") as ModelProviderOption);
      setModel(body.model_name ?? "");
      setBaseUrl(body.model_base_url ?? "");
      setCredentials(body.credentials ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, persona.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/model`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          provider: provider || null,
          model: model.trim() || null,
          base_url: isCustom ? baseUrl.trim() || null : null,
          ...(apiKey.trim() ? { key: apiKey.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to save");
      setCredentials(body.credentials ?? []);
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function removeKey(prov: string) {
    const res = await fetch(
      `/api/influencers/${persona.id}/model?provider=${prov}`,
      { method: "DELETE", headers: authHeaders(token) },
    );
    if (res.ok) {
      const body = await res.json();
      setCredentials(body.credentials ?? []);
    }
  }

  if (loading) return <Skeleton className="h-40" />;

  return (
    <Card>
      <CardContent className="pt-4 space-y-4 text-sm">
        <p className="text-muted-foreground">
          This persona runs on its own model and key — billing is isolated from
          the rest of the fleet. Leave the provider empty to use the global
          default. Use an <span className="font-medium">-compatible</span>{" "}
          endpoint to plug in a subscription/gateway (paste its base URL + token).
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Provider</p>
            <Select
              value={provider || "__global"}
              onValueChange={(v) =>
                setProvider(v === "__global" ? "" : (v as ModelProviderOption))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__global">Global default</SelectItem>
                {(Object.keys(PROVIDER_LABELS) as Array<
                  Exclude<ModelProviderOption, "">
                >).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">
              Model {isCustom ? "(required)" : "(optional)"}
            </p>
            <Input
              value={model}
              placeholder="e.g. gpt-5, claude-sonnet-5, kimi-k2..."
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
        </div>

        {isCustom && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">
              Endpoint base URL (required)
            </p>
            <Input
              value={baseUrl}
              placeholder="https://your-gateway/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
        )}

        <div>
          <p className="text-xs text-muted-foreground mb-1">
            API key / token{" "}
            <span className="text-muted-foreground">
              (write-only — stored encrypted, never shown again)
            </span>
          </p>
          <Input
            type="password"
            value={apiKey}
            placeholder={
              credentials.length
                ? "Leave blank to keep the current key"
                : "Paste the key/token"
            }
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>

        {credentials.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Stored keys
            </p>
            {credentials.map((c) => (
              <div
                key={c.provider}
                className="flex items-center gap-2 text-xs"
              >
                <Badge variant="outline">{c.provider}</Badge>
                <span className="text-muted-foreground">····{c.key_last4}</span>
                <Badge
                  variant={c.status === "active" ? "default" : "secondary"}
                >
                  {c.status}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 px-2"
                  onClick={() => removeKey(c.provider)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
        {saved && !error && (
          <p className="text-xs text-emerald-600">Saved.</p>
        )}

        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
          Save model
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Runs tab: kick off an agent job, list sessions, view the step-by-step trace
// ---------------------------------------------------------------------------

type AgentSession = {
  id: string;
  trigger: string;
  goal: string;
  status: "running" | "completed" | "failed";
  result_summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type SessionStep = {
  id: string;
  idx: number;
  kind: string;
  tool: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

const SESSION_BADGE: Record<AgentSession["status"], string> = {
  running: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

function RunsTab({
  token,
  persona,
  onChanged,
}: {
  token: string;
  persona: Persona;
  onChanged: () => void;
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, SessionStep[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/agent`, {
        headers: authHeaders(token),
      });
      const body = await res.json();
      if (res.ok) setSessions(body.sessions ?? []);
    } finally {
      setLoading(false);
    }
  }, [token, persona.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function runTask() {
    if (!goal.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/agent`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ goal: goal.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Run failed");
      setGoal("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function toggleTrace(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (!steps[id]) {
      const res = await fetch(`/api/influencers/sessions/${id}`, {
        headers: authHeaders(token),
      });
      const body = await res.json();
      if (res.ok) setSteps((prev) => ({ ...prev, [id]: body.steps ?? [] }));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-2">
          <p className="text-xs text-muted-foreground">
            Give the persona a task. It works with its own tools and model, and
            queues drafts for review — it never publishes directly.
          </p>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder="e.g. Review the latest changes in facebook/react and write a tweet on what stood out."
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <Button onClick={runTask} disabled={running || !goal.trim()}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Working…
              </>
            ) : (
              "Run task"
            )}
          </Button>
        </CardContent>
      </Card>

      {loading ? (
        <Skeleton className="h-24" />
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No runs yet. Give it a task above, or set an{" "}
            <code>agent_cadence</code> to let it run autonomously.
          </CardContent>
        </Card>
      ) : (
        sessions.map((s) => (
          <Card key={s.id}>
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                <Badge className={SESSION_BADGE[s.status]}>{s.status}</Badge>
                <Badge variant="outline">{s.trigger}</Badge>
                <span className="ml-auto">
                  {new Date(s.started_at).toLocaleString()}
                </span>
              </div>
              <p className="text-sm">{s.goal}</p>
              {s.result_summary && (
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {s.result_summary}
                </p>
              )}
              {s.error && <p className="text-xs text-red-600">{s.error}</p>}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => toggleTrace(s.id)}
              >
                {openId === s.id ? "Hide trace" : "View trace"}
              </Button>
              {openId === s.id && (
                <div className="border rounded-md p-2 space-y-1 bg-muted/40">
                  {(steps[s.id] ?? []).map((step) => (
                    <div key={step.id} className="text-xs flex gap-2">
                      <span className="text-muted-foreground tabular-nums">
                        {step.idx}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {step.tool ? `${step.kind}:${step.tool}` : step.kind}
                      </Badge>
                      <span className="text-muted-foreground truncate">
                        {JSON.stringify(step.payload).slice(0, 160)}
                      </span>
                    </div>
                  ))}
                  {(steps[s.id]?.length ?? 0) === 0 && (
                    <p className="text-xs text-muted-foreground">No steps.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan tab: the persona's self-paced autonomy — what it's doing, when it next
// acts, and a "run a shift now" button. No dated backlog; it paces itself.
// ---------------------------------------------------------------------------

type GoalProgress = {
  label: string;
  detail: string;
  current: number | null;
  onTrack: boolean | null;
};

type TickState = {
  cadence: "off" | "daily" | "weekly";
  status: "off" | "waiting" | "due";
  next_action_at: string | null;
  last_note: string | null;
  last_tick_at: string | null;
  last_session_id: string | null;
  goals?: GoalProgress[];
};

function PlanTab({ token, persona }: { token: string; persona: Persona }) {
  const [state, setState] = useState<TickState | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, {
        headers: authHeaders(token),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load");
      setState(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, persona.id]);

  useEffect(() => {
    load();
  }, [load]);

  const cadence = state?.cadence ?? "off";

  async function setCadenceRemote(next: "off" | "daily" | "weekly") {
    const previous = state;
    setState((s) => (s ? { ...s, cadence: next } : s)); // optimistic
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ action: "set_cadence", cadence: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to update the cadence");
      setState(body);
    } catch (err) {
      setState(previous); // revert so the UI matches the server
      setError(err instanceof Error ? err.message : "Failed to update the cadence");
    }
  }

  async function actNow() {
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ action: "act_now" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "The shift failed");
      setState(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The shift failed");
    } finally {
      setActing(false);
    }
  }

  const statusLine = () => {
    if (!state || cadence === "off") {
      return "Autonomy is off — it won't act on its own. Turn it on, or run a shift now.";
    }
    if (acting) return "🟢 Working a shift right now…";
    if (state.status === "waiting" && state.next_action_at) {
      return `⏳ Waiting until ${new Date(state.next_action_at).toLocaleString()} — its own choice.`;
    }
    return "🟢 Ready — it'll pick up work on the next 15-min cycle.";
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            The persona paces itself: it wakes on a heartbeat, does one real shift
            of work (research → draft/post to a connected channel), then decides
            when to come back. You only review drafts and get an alert if a shift
            fails.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Autonomy</span>
              <Select value={cadence} onValueChange={(v) => setCadenceRemote(v as typeof cadence)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off (manual only)</SelectItem>
                  <SelectItem value="daily">On — active pace</SelectItem>
                  <SelectItem value="weekly">On — light pace</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={actNow} disabled={acting}>
              {acting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1" /> Working…
                </>
              ) : (
                "Act now"
              )}
            </Button>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </CardContent>
      </Card>

      {loading ? (
        <Skeleton className="h-24" />
      ) : (
        <Card>
          <CardContent className="pt-4 space-y-2">
            <p className="text-sm">{statusLine()}</p>
            {state?.last_note && (
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground mb-1">
                  Its last note to itself
                  {state.last_tick_at
                    ? ` · ${new Date(state.last_tick_at).toLocaleString()}`
                    : ""}
                </p>
                <p className="text-sm italic">“{state.last_note}”</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              See the actual work in the Runs and Timeline tabs.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && state?.goals && state.goals.length > 0 && (
        <Card>
          <CardContent className="pt-4 space-y-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Goals
            </p>
            {state.goals.map((g, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Badge
                  className={
                    g.onTrack === true
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : g.onTrack === false
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        : "bg-muted text-muted-foreground"
                  }
                >
                  {g.onTrack === true ? "on track" : g.onTrack === false ? "behind" : "ongoing"}
                </Badge>
                <span className="font-medium">{g.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{g.detail}</span>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              The persona sees this progress each shift and steers toward what
              it&apos;s behind on.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
