import { NextResponse } from "next/server";

import { verifyEmails } from "@/lib/email-verifier";
import { getSupabaseUserClient } from "@/lib/supabase-server";

// Single-check NeverBounce calls return in <2s typically; cap maxDuration
// at 60s to absorb slow MX or retry token cases without holding the route
// open indefinitely.
export const maxDuration = 60;

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export async function POST(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const raw = Array.isArray(body.emails) ? body.emails : [];
  const emails = raw
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_REGEX.test(e));

  if (emails.length === 0) {
    return NextResponse.json(
      { error: "emails[] is required (1+ valid email)" },
      { status: 400 },
    );
  }

  // Each email = 1 NeverBounce credit. Cap to keep accidental burns bounded
  // — if the team really needs to verify >50 at once we'll switch to the
  // bulk job endpoint.
  if (emails.length > 50) {
    return NextResponse.json(
      { error: "max 50 emails per call" },
      { status: 400 },
    );
  }

  // Dedupe to avoid charging for repeated patterns.
  const unique = Array.from(new Set(emails));

  try {
    const results = await verifyEmails(unique);
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[verify-emails] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
