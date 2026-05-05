import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  addGoalLink,
  listGoalLinks,
  recalculateGoalProgress,
} from "@/lib/goals";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

async function safeReadJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }
  try {
    const links = await listGoalLinks(client, id);
    return NextResponse.json({ links });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: goalId } = await params;
  let client;
  let userEmail;
  try {
    ({ client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    ));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  const body = await safeReadJson(req);
  const workItemId =
    typeof body.workItemId === "string" ? body.workItemId : null;
  if (!workItemId) {
    return NextResponse.json(
      { error: "workItemId is required" },
      { status: 400 },
    );
  }

  try {
    await addGoalLink(client, goalId, workItemId, userEmail);
    // Auto-progress: recompute now in case the linked task is already done.
    const goal = await recalculateGoalProgress(client, goalId);
    const links = await listGoalLinks(client, goalId);
    return NextResponse.json({ goal, links }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to link" },
      { status: 500 },
    );
  }
}
