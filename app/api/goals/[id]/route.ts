import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  deleteGoal,
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  incrementGoalProgress,
  updateGoal,
  type GoalPriority,
  type GoalStatus,
  type UpdateGoalInput,
} from "@/lib/goals";

const STATUS_SET = new Set<string>(GOAL_STATUSES);
const PRIORITY_SET = new Set<string>(GOAL_PRIORITIES);

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

export async function PATCH(
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

  const body = await safeReadJson(req);

  // Special op: { delta: 1 | -1 } increments current_count and auto-flips
  // status to completed when target is reached.
  if (typeof body.delta === "number" && Number.isFinite(body.delta)) {
    try {
      const goal = await incrementGoalProgress(client, id, body.delta);
      return NextResponse.json({ goal });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to increment" },
        { status: 500 },
      );
    }
  }

  const updates: UpdateGoalInput = {};
  if (typeof body.title === "string") updates.title = body.title;
  if ("description" in body)
    updates.description =
      typeof body.description === "string" ? body.description : null;
  if ("unit" in body)
    updates.unit = typeof body.unit === "string" ? body.unit : null;
  if (typeof body.targetCount === "number")
    updates.targetCount = body.targetCount;
  if (typeof body.currentCount === "number")
    updates.currentCount = body.currentCount;
  if (typeof body.periodStart === "string")
    updates.periodStart = body.periodStart;
  if (typeof body.periodEnd === "string") updates.periodEnd = body.periodEnd;
  if (typeof body.status === "string" && STATUS_SET.has(body.status)) {
    updates.status = body.status as GoalStatus;
  }
  if (typeof body.priority === "string" && PRIORITY_SET.has(body.priority)) {
    updates.priority = body.priority as GoalPriority;
  }
  if ("responsibleEmail" in body)
    updates.responsibleEmail =
      typeof body.responsibleEmail === "string"
        ? body.responsibleEmail
        : null;
  if ("projectRef" in body)
    updates.projectRef =
      typeof body.projectRef === "string" ? body.projectRef : null;
  if ("notes" in body)
    updates.notes = typeof body.notes === "string" ? body.notes : null;

  try {
    const goal = await updateGoal(client, id, updates);
    return NextResponse.json({ goal });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update" },
      { status: 500 },
    );
  }
}

export async function DELETE(
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
    await deleteGoal(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete" },
      { status: 500 },
    );
  }
}
