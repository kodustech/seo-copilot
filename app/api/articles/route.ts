import { NextResponse } from "next/server";

import { enqueueArticleTask, fetchArticleTaskResult } from "@/lib/copilot";
import { resolveVoicePolicyForRequest } from "@/lib/voice-policy";

export async function POST(request: Request) {
  const body = await readBody(request);

  try {
    const voicePolicy = await resolveVoicePolicyForRequest(
      request.headers.get("authorization"),
    );
    const result = await enqueueArticleTask({
      title: typeof body.title === "string" ? body.title : "",
      keyword: typeof body.keyword === "string" ? body.keyword : "",
      keywordId: typeof body.keywordId === "string" ? body.keywordId : undefined,
      useResearch: Boolean(body.useResearch),
      researchInstructions:
        typeof body.researchInstructions === "string"
          ? body.researchInstructions
          : undefined,
      customInstructions:
        typeof body.customInstructions === "string"
          ? body.customInstructions
          : undefined,
      categories: normalizeCategories(body.categories),
      voicePolicy,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error generating article", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate article." },
      { status: 400 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskIdParam = searchParams.get("taskId") ?? searchParams.get("task_id");
  const taskId = Number(taskIdParam);

  if (!Number.isFinite(taskId)) {
    return NextResponse.json({ error: "Invalid task." }, { status: 400 });
  }

  try {
    const result = await fetchArticleTaskResult(taskId);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching articles", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch articles." },
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

function normalizeCategories(raw: unknown): number[] | undefined {
  if (!raw) {
    return undefined;
  }

  if (Array.isArray(raw)) {
    const values = raw
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    return values.length ? values : undefined;
  }

  const single = Number(raw);
  return Number.isFinite(single) ? [single] : undefined;
}
