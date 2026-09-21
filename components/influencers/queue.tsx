"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clapperboard, ExternalLink, Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { estimateVideoCost, YOUTUBE_WORDS_PER_SECOND } from "@/lib/influencer/youtube";

import {
  Counter,
  Empty,
  SectionLabel,
  Status,
  authHeaders,
  cls,
  fmtWhen,
  isHandPosted,
  platformLabel,
  type Activity,
  type Channel,
  type Persona,
} from "./shared";

type ReviewAction = "approve" | "discard" | "published" | "save_draft" | "render_preview";

/**
 * The review queue across the fleet. A draft reads as text first; the
 * textarea appears when a person chooses to edit, not by default.
 */
export function ReviewQueue({
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
  const personaById = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: "draft,failed", limit: "100" });
      if (personaFilter !== "all") params.set("persona_id", personaFilter);
      const res = await fetch(`/api/influencers/activities?${params}`, { headers: authHeaders(token) });
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

  async function review(id: string, action: ReviewAction, content?: string, externalUrl?: string) {
    const res = await fetch(`/api/influencers/activities/${id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({
        action,
        ...(content ? { content } : {}),
        ...(externalUrl ? { external_url: externalUrl } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to ${action} (${res.status})`);
    }
    const body = await res.json().catch(() => ({}));
    // Both keep the draft in the queue: a saved edit, or a video now rendering.
    if (action === "save_draft" || action === "render_preview") {
      const updated = body.activity as Partial<Activity> | undefined;
      setActivities((prev) => prev.map((a) => (a.id === id ? { ...a, ...(updated ?? {}) } : a)));
    } else {
      setActivities((prev) => prev.filter((a) => a.id !== id));
    }
    onChanged();
  }

  const failed = activities.filter((a) => a.status === "failed").length;
  const tests = activities.filter((a) => a.content_meta.test_run === true).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel
          hint={
            activities.length
              ? `${activities.length} waiting${tests ? `, ${tests} test` : ""}${failed ? `, ${failed} failed to publish` : ""}`
              : undefined
          }
        >
          Review queue
        </SectionLabel>
        <div className="ml-auto flex items-center gap-2">
          <Select value={personaFilter} onValueChange={setPersonaFilter}>
            <SelectTrigger className={cn(cls.select, "w-44")}>
              <SelectValue placeholder="All personas" />
            </SelectTrigger>
            <SelectContent className={cls.menu}>
              <SelectItem value="all">All personas</SelectItem>
              {personas.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  @{p.handle}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button type="button" onClick={() => load()} title="Reload" aria-label="Reload" className={cls.iconBtn}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error ? <p className={cls.error}>{error}</p> : null}

      {!loading && !error && activities.length === 0 ? (
        <Empty>
          <p>Queue is clear.</p>
          <p className="mt-1 text-neutral-600">Every active persona drafts on its own shifts; new drafts land here for review.</p>
        </Empty>
      ) : (
        <div className={cn(cls.panel, "divide-y divide-white/[0.06]")}>
          {activities.map((activity) => {
            const persona = personaById.get(activity.persona_id);
            return (
              <QueueItem
                key={activity.id}
                activity={activity}
                persona={persona}
                channel={persona?.channels.find((c) => c.id === activity.channel_id)}
                onReview={review}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function QueueItem({
  activity,
  persona,
  channel,
  onReview,
}: {
  activity: Activity;
  persona: Persona | undefined;
  channel: Channel | undefined;
  onReview: (id: string, action: ReviewAction, content?: string, externalUrl?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(activity.content);
  const [postedUrl, setPostedUrl] = useState("");
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const edited = content.trim() !== activity.content;
  const handPosted = channel ? isHandPosted(channel) : false;
  const testRun = activity.content_meta.test_run === true;
  const video = activity.kind === "video" ? videoState(activity) : null;
  const isX = channel?.platform === "x";
  const targetUrl = typeof activity.content_meta.target_url === "string" ? activity.content_meta.target_url : null;
  const canonicalUrl =
    typeof activity.content_meta.canonical_url === "string" ? activity.content_meta.canonical_url : null;
  const replyTo = typeof activity.content_meta.reply_to === "string" ? activity.content_meta.reply_to : null;

  async function act(action: ReviewAction) {
    setBusy(action);
    setActionError(null);
    try {
      await onReview(
        activity.id,
        action,
        edited ? content.trim() : undefined,
        action === "published" ? postedUrl.trim() || undefined : undefined,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span className="font-medium text-neutral-200">@{persona?.handle ?? "?"}</span>
        <span className="text-neutral-300">{channel ? platformLabel(channel.platform) : "unknown channel"}</span>
        <span>{activity.kind}</span>
        {testRun ? <Status tone="info">test</Status> : null}
        {handPosted ? <span className="text-amber-300">posted by hand</span> : null}
        {activity.status === "failed" ? <Status tone="bad">failed to publish</Status> : null}
        {replyTo ? (
          <a href={replyTo} target="_blank" rel="noreferrer" className={cls.link}>
            replying to
          </a>
        ) : null}
        {targetUrl ? (
          <a href={targetUrl} target="_blank" rel="noreferrer" className={cls.link}>
            where to post
          </a>
        ) : null}
        {canonicalUrl ? (
          <a href={canonicalUrl} target="_blank" rel="noreferrer" className={cls.link}>
            {channel?.platform === "medium" ? "page to import" : "original"}
          </a>
        ) : null}
        {activity.source_ref && /^https?:\/\//.test(activity.source_ref) ? (
          <a href={activity.source_ref} target="_blank" rel="noreferrer" className={cls.link}>
            source
          </a>
        ) : null}
        <span className="ml-auto tabular-nums">{fmtWhen(activity.created_at)}</span>
      </div>

      {activity.title ? <p className="text-sm font-medium text-neutral-100">{activity.title}</p> : null}

      {editing ? (
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={Math.min(14, Math.max(3, content.split("\n").length + 1))}
          className={cls.textarea}
          autoFocus
        />
      ) : activity.kind === "video" ? (
        <VideoStoryboard activity={activity} content={content} />
      ) : (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-white/[0.06] bg-neutral-950/40 p-3 text-sm leading-relaxed text-neutral-200">
          {content}
        </p>
      )}

      {activity.error ? <p className={cls.errorText}>{activity.error}</p> : null}
      {actionError ? <p className={cls.errorText}>{actionError}</p> : null}

      {handPosted && !testRun ? (
        <Input
          value={postedUrl}
          onChange={(event) => setPostedUrl(event.target.value)}
          placeholder="Link to the post once it is up (optional)"
          className={cls.input}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <button type="button" disabled={busy !== null || !content.trim()} onClick={() => act("save_draft")} className={cls.outline}>
            {busy === "save_draft" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save draft
          </button>
        ) : null}
        {video?.canRender ? (
          <button type="button" disabled={busy !== null || edited} onClick={() => act("render_preview")} className={cls.outline}>
            {busy === "render_preview" ? <Loader2 className="size-3.5 animate-spin" /> : <Clapperboard className="size-3.5" />}
            {video.retry ? "Retry render" : `Render preview (~${video.estimatedCredits} credits)`}
          </button>
        ) : null}
        {testRun ? (
          <Status tone="muted">Review only · cannot publish or schedule</Status>
        ) : handPosted ? (
          <button type="button" disabled={busy !== null || !content.trim()} onClick={() => act("published")} className={cls.primary}>
            {busy === "published" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Mark as published
          </button>
        ) : (
          <button type="button" disabled={busy !== null || !content.trim()} onClick={() => act("approve")} className={cls.primary}>
            {busy === "approve" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {video ? (video.finalUrl ? "Approve and upload" : "Approve script") : edited ? "Save and approve" : "Approve"}
          </button>
        )}
        {video?.renderStarted ? null : (
          <button type="button" onClick={() => setEditing((v) => !v)} className={cls.ghost}>
            <Pencil className="size-3.5" /> {editing ? "Done editing" : "Edit"}
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => act("discard")} className={cn(cls.ghost, "hover:text-red-300")}>
          {busy === "discard" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          Discard
        </button>
        {activity.external_url ? (
          <a href={activity.external_url} target="_blank" rel="noreferrer" className={cn(cls.ghost)}>
            <ExternalLink className="size-3.5" /> Open
          </a>
        ) : null}
        <span className="ml-auto">{isX ? <Counter n={content.trim().length} max={280} /> : null}</span>
      </div>
    </article>
  );
}

/**
 * A video draft as the viewer will get it: one row per screen, the slide
 * preview (or "on camera") next to what is said while it is up. The text is
 * the current draft, which is what gets filmed; the previews come from the
 * worker a few minutes after the draft lands.
 */
function VideoStoryboard({ activity, content }: { activity: Activity; content: string }) {
  const meta = activity.content_meta;
  const blocks = content
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const visuals = Array.isArray(meta.visuals) ? (meta.visuals as unknown[]) : null;
  const previews = Array.isArray(meta.slide_previews) ? (meta.slide_previews as unknown[]) : [];
  const previewError = typeof meta.slide_previews_error === "string" ? meta.slide_previews_error : null;
  const words = blocks.reduce((n, b) => n + b.split(" ").length, 0);
  const minutes = words / YOUTUBE_WORDS_PER_SECOND / 60;
  const slideCount = visuals ? visuals.filter((v) => v !== null).length : 0;
  const unpaired = visuals !== null && visuals.length !== blocks.length;
  const state = videoState(activity);
  const testRun = meta.test_run === true;
  return (
    <div className="space-y-2">
      {state.finalUrl ? (
        <div className="space-y-1">
          <video src={state.finalUrl} controls preload="metadata" className="w-full max-w-3xl rounded-md border border-white/[0.06] bg-black" />
          <p className="text-xs text-neutral-500">
            {testRun ? "Test render: watch it here; it cannot be published." : "The finished video. Approving it is what uploads it to YouTube."}
          </p>
        </div>
      ) : null}
      {state.progress ? <p className="text-xs text-amber-300">{state.progress}</p> : null}
      {state.renderError ? <p className={cls.errorText}>Render stopped: {state.renderError}</p> : null}
      <p className="text-xs text-neutral-500">
        ~{minutes.toFixed(1)} min · {blocks.length} screens · {slideCount} slides
        {visuals && !meta.slide_previews_for ? " · slide previews rendering" : ""}
      </p>
      {unpaired ? (
        <p className={cls.errorText}>
          The text has {blocks.length} paragraphs for {visuals!.length} screens. Keep one paragraph per screen or the render refuses it.
        </p>
      ) : null}
      {previewError ? <p className={cls.errorText}>Slide preview failed: {previewError}</p> : null}
      <ol className="max-h-[32rem] space-y-2 overflow-y-auto">
        {blocks.map((block, i) => {
          const url = typeof previews[i] === "string" ? (previews[i] as string) : null;
          const onCamera = visuals ? visuals[i] === null : false;
          return (
            <li key={i} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-3 rounded-md border border-white/[0.06] bg-neutral-950/40 p-2">
              <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-neutral-900 text-[11px] text-neutral-500">
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`Slide for screen ${i + 1}`} className="size-full object-cover" />
                  </a>
                ) : onCamera ? (
                  "on camera"
                ) : (
                  "slide preview pending"
                )}
              </div>
              <p className="text-sm leading-relaxed text-neutral-200">
                <span className="mr-1.5 tabular-nums text-neutral-500">{i + 1}</span>
                {block}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Where a video draft stands between script and finished file, read off its
 * content_meta: what the reviewer can do next and what is still running.
 */
function videoState(activity: Activity) {
  const meta = activity.content_meta;
  const blocks = Array.isArray(meta.blocks) ? (meta.blocks as unknown[]).filter((b) => typeof b === "string") : [];
  // Price what will be filmed: the saved text wins over the stored blocks, as it does in the render.
  const spoken = activity.content?.trim() ? activity.content : (blocks as string[]).join(" ");
  const words = spoken.split(/\s+/).filter(Boolean).length;
  const finalUrl = typeof meta.final_url === "string" && meta.final_url ? meta.final_url : null;
  const ids = Array.isArray(meta.heygen_video_ids) ? (meta.heygen_video_ids as unknown[]).filter(Boolean) : [];
  const clips = Array.isArray(meta.video_urls) ? (meta.video_urls as unknown[]).filter(Boolean).length : 0;
  const renderError = typeof meta.render_error === "string" ? meta.render_error : null;
  // A composite the worker gave up on is not still rendering: it needs a retry.
  const rendering = meta.render_requested === true && !finalUrl && !meta.worker_failed_at;
  let progress: string | null = null;
  if (!finalUrl && meta.stage === "clips_ready") progress = "Clips ready · composing the video (a few minutes)";
  else if (rendering && ids.length) progress = `Rendering the avatar · ${clips} of ${blocks.length} clips ready`;
  else if (rendering) progress = "Queued to render on the next publish run (within 15 minutes)";
  return {
    finalUrl,
    renderError,
    progress,
    renderStarted: ids.length > 0 || Boolean(finalUrl),
    // A fresh draft, or a retry after a render or composite that stopped.
    canRender: !finalUrl && !rendering && (ids.length === 0 || Boolean(renderError) || activity.status === "failed"),
    retry: ids.length > 0,
    estimatedCredits: estimateVideoCost(words / YOUTUBE_WORDS_PER_SECOND),
  };
}
