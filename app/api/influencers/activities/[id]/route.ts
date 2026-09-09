import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  getActivity,
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
      body.action === "published"
        ? body.action
        : null;

    if (!action) {
      return NextResponse.json(
        { error: "action must be approve, discard, edit or published." },
        { status: 400 },
      );
    }

    const current = await getActivity(client, id);
    if (!current) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
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
    if (typeof body.title === "string") {
      patch.title = body.title.trim() || null;
    }
    if (typeof body.scheduled_at === "string" || body.scheduled_at === null) {
      patch.scheduled_at = body.scheduled_at;
    }

    if (action === "approve") {
      patch.status = "approved";
      patch.approved_by = userEmail;
      patch.error = null;
    } else if (action === "published") {
      patch.status = "published";
      patch.published_at = new Date().toISOString();
      patch.external_url = externalUrl || null;
      patch.approved_by = userEmail;
      patch.error = null;
    } else if (action === "discard") {
      patch.status = "discarded";
    } else if (!Object.keys(patch).length) {
      // Plain edit with nothing to change: return as-is.
      return NextResponse.json({ activity: current });
    }

    // Guarded update: only applies while the row is still reviewable, so a
    // concurrent reviewer (or the publisher claiming it) wins cleanly.
    const activity = await updateActivityIfStatus(client, id, patch, REVIEWABLE);
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
