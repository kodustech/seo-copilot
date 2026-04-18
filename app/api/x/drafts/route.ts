import { NextResponse } from "next/server";

import {
  generateDraftsForCandidate,
  type CandidateForDraft,
} from "@/lib/reply-radar";
import { getSupabaseUserClient } from "@/lib/supabase-server";
import { resolveVoicePolicyForUser } from "@/lib/voice-policy";

const DRAFT_COLUMNS = "id, candidate_id, position, angle, draft_text, selected";

export async function PATCH(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : null;
    if (!id) {
      return NextResponse.json({ error: "Missing draft id." }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (typeof body?.draftText === "string") {
      updates.draft_text = body.draftText.trim();
    }
    if (typeof body?.selected === "boolean") {
      updates.selected = body.selected;
    }

    if (!Object.keys(updates).length) {
      return NextResponse.json(
        { error: "No valid fields to update." },
        { status: 400 },
      );
    }

    const { data, error } = await client
      .from("x_reply_drafts")
      .update(updates)
      .eq("id", id)
      .eq("user_email", userEmail)
      .select(DRAFT_COLUMNS)
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ draft: data });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const body = await request.json().catch(() => ({}));
    const candidateId = typeof body?.candidateId === "string" ? body.candidateId : null;
    if (!candidateId) {
      return NextResponse.json(
        { error: "Missing candidateId." },
        { status: 400 },
      );
    }

    const { data: candidate, error: candidateError } = await client
      .from("x_reply_candidates")
      .select(
        "id, user_email, post_text, author_username, author_display_name, metrics",
      )
      .eq("id", candidateId)
      .eq("user_email", userEmail)
      .single();

    if (candidateError || !candidate) {
      return NextResponse.json({ error: "Candidate not found." }, { status: 404 });
    }

    const voicePolicy = await resolveVoicePolicyForUser(userEmail);
    const drafts = await generateDraftsForCandidate({
      candidate: candidate as CandidateForDraft,
      voicePolicy,
    });

    if (!drafts.length) {
      return NextResponse.json(
        { error: "Failed to generate any drafts." },
        { status: 502 },
      );
    }

    await client
      .from("x_reply_drafts")
      .delete()
      .eq("candidate_id", candidateId)
      .eq("user_email", userEmail);

    const rows = drafts.map((draft, index) => ({
      candidate_id: candidateId,
      user_email: userEmail,
      position: index + 1,
      angle: draft.angle,
      draft_text: draft.text,
    }));

    const { data: inserted, error: insertError } = await client
      .from("x_reply_drafts")
      .insert(rows)
      .select(DRAFT_COLUMNS);

    if (insertError) throw new Error(insertError.message);

    await client
      .from("x_reply_candidates")
      .update({ status: "drafted" })
      .eq("id", candidateId)
      .eq("user_email", userEmail);

    return NextResponse.json({ drafts: inserted ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error.";
  const status =
    message.toLowerCase().includes("token") ||
    message.toLowerCase().includes("unauthorized")
      ? 401
      : 500;
  return NextResponse.json({ error: message }, { status });
}
