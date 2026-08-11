import { NextResponse } from "next/server";

import { withUser } from "@/lib/db";
import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  getActivity,
  updateActivity,
  type ActivityPatch,
} from "@/lib/influencer/drizzle/activities";
import { influencerTableMissingMessage } from "@/lib/influencer/types";

export const maxDuration = 60;

/** Review actions never touch rows that are already on (or going to) the wire. */
const REVIEWABLE = new Set(["draft", "approved", "scheduled", "failed"]);

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action =
      body.action === "approve" || body.action === "discard" || body.action === "edit"
        ? body.action
        : null;

    if (!action) {
      return NextResponse.json(
        { error: "action must be approve, discard or edit." },
        { status: 400 },
      );
    }

    const activity = await withUser({ email: userEmail }, async (tx) => {
      const current = await getActivity(tx, id);
      if (!current) return null;
      if (!REVIEWABLE.has(current.status)) {
        throw new Error(
          `Activity is ${current.status} and can no longer be reviewed.`,
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
      } else if (action === "discard") {
        patch.status = "discarded";
      }

      return updateActivity(tx, id, patch);
    });

    if (!activity) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
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
    if (message.includes("can no longer be reviewed")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
