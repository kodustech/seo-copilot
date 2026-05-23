import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { GOAL_KINDS, GOAL_PRIORITIES, type GoalKind, type GoalPriority } from "@/lib/goals";
import {
  GOAL_CADENCES,
  createRecurrence,
  listRecurrences,
  materializeRecurrence,
  type GoalCadence,
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

export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    const url = new URL(req.url);
    const activeParam = url.searchParams.get("active");
    const filters: { active?: boolean } = {};
    if (activeParam === "true") filters.active = true;
    else if (activeParam === "false") filters.active = false;

    const recurrences = await listRecurrences(client, filters);
    return NextResponse.json({ recurrences });
  } catch (err) {
    console.error("[api/goals/recurrences] GET failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
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
  const title = typeof body.title === "string" ? body.title : null;
  const cadence =
    typeof body.cadence === "string" && CADENCE_SET.has(body.cadence)
      ? (body.cadence as GoalCadence)
      : null;

  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!cadence) {
    return NextResponse.json(
      { error: "cadence must be 'weekly' or 'monthly'" },
      { status: 400 },
    );
  }

  const kind =
    typeof body.kind === "string" && KIND_SET.has(body.kind)
      ? (body.kind as GoalKind)
      : undefined;
  const priority =
    typeof body.priority === "string" && PRIORITY_SET.has(body.priority)
      ? (body.priority as GoalPriority)
      : undefined;

  try {
    const recurrence = await createRecurrence(client, {
      title,
      description:
        typeof body.description === "string" ? body.description : null,
      unit: typeof body.unit === "string" ? body.unit : null,
      kind,
      targetCount:
        typeof body.targetCount === "number" ? body.targetCount : undefined,
      priority,
      cadence,
      active: typeof body.active === "boolean" ? body.active : undefined,
      responsibleEmail:
        typeof body.responsibleEmail === "string"
          ? body.responsibleEmail
          : null,
      projectRef: typeof body.projectRef === "string" ? body.projectRef : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      createdByEmail: userEmail,
    });

    // Create the instance for the current period right away so the user sees
    // the goal without waiting for the next cron tick.
    let goal = null;
    if (recurrence.active) {
      try {
        goal = await materializeRecurrence(client, recurrence);
      } catch (err) {
        console.error(
          "[api/goals/recurrences] initial materialize failed:",
          err,
        );
      }
    }

    return NextResponse.json({ recurrence, goal }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create" },
      { status: 500 },
    );
  }
}
