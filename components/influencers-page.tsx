"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
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
  disclosure: string;
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

const ONBOARDING_STEPS: Array<{ key: string; label: string }> = [
  { key: "account_created", label: "Account created on the platform" },
  { key: "automation_label", label: "Automation label enabled (X)" },
  { key: "disclosure_in_bio", label: "AI disclosure in the bio" },
  { key: "credentials_linked", label: "Credentials linked (Post-Bridge / api-key)" },
];

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
      if (res.ok) setActivities(body.activities ?? []);
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
    if (res.ok) {
      setActivities((prev) => prev.filter((a) => a.id !== id));
      onChanged();
    }
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

      {!loading && activities.length === 0 ? (
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
  const edited = content.trim() !== activity.content;
  const lane =
    typeof activity.content_meta.lane === "string"
      ? activity.content_meta.lane
      : null;

  async function act(action: "approve" | "discard") {
    setBusy(action);
    try {
      await onReview(activity.id, action, edited ? content.trim() : undefined);
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

  const loadActivities = useCallback(async () => {
    setLoadingActivities(true);
    try {
      const res = await fetch(
        `/api/influencers/activities?persona_id=${persona.id}&limit=100`,
        { headers: authHeaders(token) },
      );
      const body = await res.json();
      if (res.ok) setActivities(body.activities ?? []);
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
      await fetch(`/api/influencers/${persona.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          status: persona.status === "active" ? "paused" : "active",
        }),
      });
      onChanged();
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

      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-4 space-y-3">
          {loadingActivities ? (
            <Skeleton className="h-24" />
          ) : activities.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Nothing yet. Activate the persona and drafts start landing on
                the next daily run.
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
                  AI disclosure (mandatory)
                </p>
                <p>{persona.disclosure}</p>
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
  const [handle, setHandle] = useState(channel.external_handle ?? "");
  const [bridgeId, setBridgeId] = useState(
    channel.channel_config.post_bridge_account_id
      ? String(channel.channel_config.post_bridge_account_id)
      : "",
  );
  const isDraftOnly = channel.automation_level === "draft_only";
  const onboardingDone = ONBOARDING_STEPS.every(
    (step) => channel.onboarding[step.key],
  );

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      await fetch(`/api/influencers/channels/${channel.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      onChanged();
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
          {channel.status !== "active" && (
            <Button
              size="sm"
              className="ml-auto"
              disabled={saving || !onboardingDone}
              title={
                onboardingDone
                  ? undefined
                  : "Finish the onboarding checklist first"
              }
              onClick={() => patch({ status: "active" })}
            >
              Activate channel
            </Button>
          )}
          {channel.status === "active" && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={saving}
              onClick={() => patch({ status: "paused" })}
            >
              Pause
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
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
          {channel.publish_via === "post_bridge" && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Post-Bridge account id
              </p>
              <Input
                value={bridgeId}
                placeholder="e.g. 123"
                onChange={(event) => setBridgeId(event.target.value)}
                onBlur={() => {
                  const parsed = Number(bridgeId);
                  patch({
                    channel_config: {
                      ...channel.channel_config,
                      post_bridge_account_id:
                        Number.isInteger(parsed) && parsed > 0 ? parsed : null,
                    },
                  });
                }}
              />
            </div>
          )}
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
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            Onboarding checklist
          </p>
          {ONBOARDING_STEPS.map((step) => (
            <label
              key={step.key}
              className="flex items-center gap-2 text-sm cursor-pointer"
            >
              <Switch
                checked={Boolean(channel.onboarding[step.key])}
                onCheckedChange={(checked) =>
                  patch({
                    onboarding: { ...channel.onboarding, [step.key]: checked },
                  })
                }
              />
              {step.label}
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
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
                AI disclosure (goes in the bio, non-negotiable)
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
