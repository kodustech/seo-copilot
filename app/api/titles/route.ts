import { NextResponse } from "next/server";

import { fetchTitlesFromCopilot } from "@/lib/copilot";
import { resolveVoicePolicyForRequest } from "@/lib/voice-policy";

export async function POST(request: Request) {
  const body = await readBody(request);

  try {
    const keywords = normalizeKeywordPayload(body.keywords);
    const voicePolicy = await resolveVoicePolicyForRequest(
      request.headers.get("authorization"),
    );
    const result = await fetchTitlesFromCopilot({
      keywords,
      voicePolicy,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error generating titles", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate titles." },
      { status: 400 },
    );
  }
}

async function readBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function normalizeKeywordPayload(
  raw: unknown,
): { keyword: string; instruction?: string }[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: { keyword: string; instruction?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const keyword = String(record.keyword ?? "").trim();
    if (!keyword) {
      continue;
    }
    const instruction =
      typeof record.instruction === "string"
        ? record.instruction.trim()
        : undefined;
    entries.push({
      keyword,
      instruction: instruction && instruction.length > 0 ? instruction : undefined,
    });
  }
  return entries;
}
