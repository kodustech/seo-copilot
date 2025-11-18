import { NextResponse } from "next/server";

import { fetchTitlesFromCopilot } from "@/lib/copilot";

export async function POST(request: Request) {
  const body = await readBody(request);

  try {
    const keywords = normalizeKeywordPayload(body.keywords);
    const result = await fetchTitlesFromCopilot({
      keywords,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Erro ao gerar títulos", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao gerar títulos." },
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
