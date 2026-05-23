import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { GOAL_KINDS, GOAL_PRIORITIES, type GoalKind, type GoalPriority } from "@/lib/goals";
import {
  GOAL_CADENCES,
  deleteRecurrence,
  materializeRecurrence,
  updateRecurrence,
  type GoalCadence,
  type UpdateRecurrenceInput,
} from "@/lib/goal-recurrences";

const KIND_SET = new Set<string>(GOAL_KINDS);
const PRIORITY_SET = new Set<string>(GOAL_PRIORITIES);
const CADENCE_SET = new Set<string>(GOAL_CADENCES);

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

  const updates: UpdateRecurrenceInput = {};
  if (typeof body.title === "string") updates.title = body.title;
  if ("description" in body)
    updates.description =
      typeof body.description === "string" ? body.description : null;
  if ("unit" in body)
    updates.unit = typeof body.unit === "string" ? body.unit : null;
  if (typeof body.kind === "string" && KIND_SET.has(body.kind))
    updates.kind = body.kind as GoalKind;
  if (typeof body.targetCount === "number")
    updates.targetCount = body.targetCount;
  if (typeof body.priority === "string" && PRIORITY_SET.has(body.priority))
    updates.priority = body.priority as GoalPriority;
  if (typeof body.cadence === "string" && CADENCE_SET.has(body.cadence))
    updates.cadence = body.cadence as GoalCadence;
  if (typeof body.active === "boolean") updates.active = body.active;
  if ("responsibleEmail" in body)
    updates.responsibleEmail =
      typeof body.responsibleEmail === "string" ? body.responsibleEmail : null;
  if ("projectRef" in body)
    updates.projectRef =
      typeof body.projectRef === "string" ? body.projectRef : null;
  if ("notes" in body)
    updates.notes = typeof body.notes === "string" ? body.notes : null;

  try {
    const recurrence = await updateRecurrence(client, id, updates);
    // If the rule was just (re)activated, make sure the current period has an
    // instance.
    let goal = null;
    if (recurrence.active) {
      try {
        goal = await materializeRecurrence(client, recurrence);
      } catch (err) {
        console.error("[api/goals/recurrences] materialize on patch failed:", err);
      }
    }
    return NextResponse.json({ recurrence, goal });
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
    await deleteRecurrence(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete" },
      { status: 500 },
    );
  }
}
