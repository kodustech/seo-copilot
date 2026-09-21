import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  getActivity,
  isTestActivity,
  updateActivityIfStatus,
  type ActivityPatch,
} from "@/lib/influencer/activities";
import { getChannel } from "@/lib/influencer/personas";
import {
  influencerTableMissingMessage,
  type ActivityStatus,
} from "@/lib/influencer/types";

export const maxDuration = 60;

/** Review actions never touch rows that are already on (or going to) the wire. */
const REVIEWABLE: ActivityStatus[] = ["draft", "approved", "scheduled", "failed"];

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action =
      body.action === "approve" ||
      body.action === "discard" ||
      body.action === "edit" ||
      body.action === "published" ||
      body.action === "save_draft" ||
      body.action === "cancel_schedule" ||
      body.action === "render_preview"
        ? body.action
        : null;

    if (!action) {
      return NextResponse.json(
        { error: "action must be approve, discard, edit, published, save_draft, cancel_schedule or render_preview." },
        { status: 400 },
      );
    }

    const current = await getActivity(client, id);
    if (!current) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }

    const testEditSchedules =
      action === "edit" && body.scheduled_at !== undefined && body.scheduled_at !== null;
    if (
      isTestActivity(current) &&
      (action === "approve" ||
        action === "published" ||
        action === "cancel_schedule" ||
        testEditSchedules)
    ) {
      return NextResponse.json(
        { error: "Test drafts can be edited or discarded, but cannot be published or scheduled." },
        { status: 400 },
      );
    }

    // A hand-posted channel has no publisher: a person posts and records the
    // link. "approve" there would park the draft forever, and "published"
    // anywhere else would claim a post the tool never sent.
    const channel = await getChannel(client, current.channel_id);
    const handPosted = channel?.publish_via === "manual";
    if (action === "approve" && handPosted) {
      return NextResponse.json(
        { error: "This channel is posted by hand. Post it from your account, then mark it published with the link." },
        { status: 400 },
      );
    }
    if (action === "published" && !handPosted) {
      return NextResponse.json(
        { error: "Only hand-posted channels are marked published by a person; this one publishes on its own." },
        { status: 400 },
      );
    }
    if (action === "cancel_schedule" && current.status !== "scheduled") {
      return NextResponse.json(
        { error: "Only scheduled activities can have their schedule cancelled." },
        { status: 400 },
      );
    }
    const externalUrl =
      typeof body.external_url === "string" ? body.external_url.trim() : "";
    if (action === "published" && externalUrl && !/^https?:\/\/\S+$/i.test(externalUrl)) {
      return NextResponse.json(
        { error: "external_url must be a full http(s) link to the post." },
        { status: 400 },
      );
    }

    const patch: ActivityPatch = {};
    if (typeof body.content === "string" && body.content.trim()) {
      patch.content = body.content.trim();
    }
    // Once HeyGen has clips for a script, new words would not change them:
    // the render would silently film the old text.
    const renderStarted =
      current.kind === "video" &&
      ((Array.isArray(current.content_meta.heygen_video_ids) &&
        current.content_meta.heygen_video_ids.some(Boolean)) ||
        Boolean(current.content_meta.final_url));
    // Only actions that carry a text edit: the queue sends its textarea with
    // every action, and a discard must always go through.
    const editsText = action === "edit" || action === "save_draft" || action === "approve" || action === "render_preview";
    if (renderStarted && editsText && patch.content !== undefined && patch.content !== current.content) {
      return NextResponse.json(
        { error: "This video is already rendered or rendering, so a text edit would not reach it. Discard it and queue a new one." },
        { status: 409 },
      );
    }
    if (typeof body.title === "string") {
      patch.title = body.title.trim() || null;
    }
    if (typeof body.scheduled_at === "string" || body.scheduled_at === null) {
      patch.scheduled_at = body.scheduled_at;
    }

    if (action === "render_preview") {
      // Render the full video and bring it back here to watch. Test drafts
      // too: the draft stays a draft, so it still cannot publish. Doubles as
      // the retry after a failed render or composite.
      if (current.kind !== "video") {
        return NextResponse.json({ error: "Only videos have a preview to render." }, { status: 400 });
      }
      if (current.content_meta.final_url) {
        return NextResponse.json({ error: "This video is already rendered. Watch it in the queue." }, { status: 400 });
      }
      // With the clips already made, only the composite needs another go:
      // clearing the worker's failure is the retry. A render request would
      // only hold a preview slot the next draft needs.
      const clipsReady = current.content_meta.stage === "clips_ready";
      const meta: Record<string, unknown> = { ...current.content_meta, render_requested: !clipsReady };
      for (const key of ["render_error", "worker_failed_at", "worker_attempts", "worker_error", "worker_retry_at"]) delete meta[key];
      patch.content_meta = meta;
      patch.status = "draft";
      patch.error = null;
    } else if (action === "approve") {
      patch.status = "approved";
      patch.approved_by = userEmail;
      patch.error = null;
      // A video the worker gave up on: approving it again is the retry, with
      // fresh attempts. The clips already rendered stay and are reused.
      if (current.kind === "video" && current.content_meta.worker_failed_at) {
        const meta = { ...current.content_meta };
        for (const key of ["worker_failed_at", "worker_attempts", "worker_error", "worker_retry_at"]) delete meta[key];
        patch.content_meta = meta;
      }
    } else if (action === "published") {
      patch.status = "published";
      patch.published_at = new Date().toISOString();
      patch.external_url = externalUrl || null;
      patch.approved_by = userEmail;
      patch.error = null;
    } else if (action === "discard") {
      patch.status = "discarded";
    } else if (action === "save_draft") {
      patch.status = "draft";
      patch.scheduled_at = null;
      patch.approved_by = null;
      patch.error = null;
    } else if (action === "cancel_schedule") {
      patch.status = "draft";
      patch.scheduled_at = null;
      patch.approved_by = null;
      patch.error = null;
    } else if (!Object.keys(patch).length) {
      // Plain edit with nothing to change: return as-is.
      return NextResponse.json({ activity: current });
    }

    // Guarded update: only applies while the row is still reviewable, so a
    // concurrent reviewer (or the publisher claiming it) wins cleanly.
    const allowedFrom: ActivityStatus[] = action === "cancel_schedule" ? ["scheduled"] : REVIEWABLE;
    const activity = await updateActivityIfStatus(client, id, patch, allowedFrom);
    if (!activity) {
      return NextResponse.json(
        {
          error: `Activity is ${current.status} (or just changed) and can no longer be reviewed.`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ activity });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    const missing = influencerTableMissingMessage(error);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 500 });
    }
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
