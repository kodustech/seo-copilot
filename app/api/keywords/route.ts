import { NextResponse } from "next/server";

import {
  enqueueKeywordTask,
  fetchKeywordTaskResult,
} from "@/lib/copilot";

export async function POST(request: Request) {
  const body = await readBody(request);
  try {
    const limit = normalizeLimit(body.limit);
    const locationCode = normalizeLocationCode(
      body.locationCode ?? body.location_code,
    );
    const language = normalizeLanguage(body.language);
    const result = await enqueueKeywordTask({
      idea: typeof body.idea === "string" ? body.idea : undefined,
      limit,
      locationCode,
      language,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Erro ao gerar keywords", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao gerar keywords." },
      { status: 400 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const param = searchParams.get("taskId") ?? searchParams.get("task_id");
  const numericId = Number(param);

  if (!Number.isFinite(numericId)) {
    return NextResponse.json(
      { error: "Task inválida." },
      { status: 400 },
    );
  }

  try {
    const result = await fetchKeywordTaskResult(numericId);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Erro ao consultar task", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao consultar task." },
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

function normalizeLimit(raw: unknown): number | undefined {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : undefined;
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const numeric = Math.round(Number(value));
  const clamped = Math.min(50, Math.max(5, numeric));
  return clamped;
}

function normalizeLocationCode(raw: unknown): number | undefined {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : undefined;

  if (!Number.isFinite(value)) {
    return undefined;
  }

  const numeric = Math.round(Number(value));
  return numeric;
}

function normalizeLanguage(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "pt" || value === "en") {
    return value;
  }
  return undefined;
}
