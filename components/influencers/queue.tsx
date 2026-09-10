"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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

type ReviewAction = "approve" | "discard" | "published";

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
    setActivities((prev) => prev.filter((a) => a.id !== id));
    onChanged();
  }

  const failed = activities.filter((a) => a.status === "failed").length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel
          hint={
            activities.length
              ? `${activities.length} waiting${failed ? `, ${failed} failed to publish` : ""}`
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
      ) : (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{content}</p>
      )}

      {activity.error ? <p className={cls.errorText}>{activity.error}</p> : null}
      {actionError ? <p className={cls.errorText}>{actionError}</p> : null}

      {handPosted ? (
        <Input
          value={postedUrl}
          onChange={(event) => setPostedUrl(event.target.value)}
          placeholder="Link to the post once it is up (optional)"
          className={cls.input}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {handPosted ? (
          <button type="button" disabled={busy !== null || !content.trim()} onClick={() => act("published")} className={cls.primary}>
            {busy === "published" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Mark as published
          </button>
        ) : (
          <button type="button" disabled={busy !== null || !content.trim()} onClick={() => act("approve")} className={cls.primary}>
            {busy === "approve" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {edited ? "Save and approve" : "Approve"}
          </button>
        )}
        <button type="button" onClick={() => setEditing((v) => !v)} className={cls.ghost}>
          <Pencil className="size-3.5" /> {editing ? "Done editing" : "Edit"}
        </button>
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
