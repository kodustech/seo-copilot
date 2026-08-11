import { NextResponse } from "next/server";

import { withUser } from "@/lib/db";
import { getSupabaseUserClient } from "@/lib/supabase-server";

import { listPersonas } from "@/lib/influencer/drizzle/personas";
import {
  generatePersonaAvatar,
  generatePersonaProposal,
} from "@/lib/influencer/wizard";
import { influencerTableMissingMessage } from "@/lib/influencer/types";

export const maxDuration = 300;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function POST(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const direction = typeof body.direction === "string" ? body.direction : "";
    if (!direction.trim()) {
      return NextResponse.json(
        { error: "Describe the niche/direction for the new persona." },
        { status: 400 },
      );
    }

    const existing = await withUser({ email: userEmail }, (tx) =>
      listPersonas(tx),
    );

    const proposal = await generatePersonaProposal({
      direction,
      objective: typeof body.objective === "string" ? body.objective : undefined,
      language: typeof body.language === "string" ? body.language : undefined,
      existing: existing.map((p) => ({
        handle: p.handle,
        beat: p.beat,
        tone: p.tone,
      })),
    });

    let avatarUrl: string | null = null;
    if (body.with_avatar !== false) {
      try {
        avatarUrl = await generatePersonaAvatar({
          avatarPrompt: proposal.avatar_prompt,
        });
      } catch (error) {
        // The avatar is nice-to-have; the proposal is the product.
        console.warn("[influencer] avatar generation failed:", error);
      }
    }

    return NextResponse.json({ proposal: { ...proposal, avatar_url: avatarUrl } });
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
