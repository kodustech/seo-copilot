import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  createGoal,
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  getGoalStats,
  listGoals,
  type GoalFilters,
  type GoalPriority,
  type GoalStatus,
} from "@/lib/goals";

const STATUS_SET = new Set<string>(GOAL_STATUSES);
const PRIORITY_SET = new Set<string>(GOAL_PRIORITIES);
const SCOPE_SET = new Set(["current", "upcoming", "past", "all"]);

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
    const status = url.searchParams.get("status");
    const responsibleEmail = url.searchParams.get("responsibleEmail");
    const periodScope = url.searchParams.get("periodScope");

    const filters: GoalFilters = {};
    if (status && STATUS_SET.has(status)) {
      filters.status = status as GoalStatus;
    }
    if (responsibleEmail) filters.responsibleEmail = responsibleEmail;
    if (periodScope && SCOPE_SET.has(periodScope)) {
      filters.periodScope = periodScope as GoalFilters["periodScope"];
    }

    const [goals, stats] = await Promise.all([
      listGoals(client, filters),
      getGoalStats(client),
    ]);
    return NextResponse.json({ goals, stats });
  } catch (err) {
    console.error("[api/goals] GET failed:", err);
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
  const periodStart =
    typeof body.periodStart === "string" ? body.periodStart : null;
  const periodEnd =
    typeof body.periodEnd === "string" ? body.periodEnd : null;

  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!periodStart || !periodEnd) {
    return NextResponse.json(
      { error: "periodStart and periodEnd are required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  const status =
    typeof body.status === "string" && STATUS_SET.has(body.status)
      ? (body.status as GoalStatus)
      : undefined;
  const priority =
    typeof body.priority === "string" && PRIORITY_SET.has(body.priority)
      ? (body.priority as GoalPriority)
      : undefined;

  try {
    const goal = await createGoal(client, {
      title,
      description:
        typeof body.description === "string" ? body.description : null,
      unit: typeof body.unit === "string" ? body.unit : null,
      targetCount:
        typeof body.targetCount === "number" ? body.targetCount : undefined,
      currentCount:
        typeof body.currentCount === "number" ? body.currentCount : undefined,
      periodStart,
      periodEnd,
      status,
      priority,
      responsibleEmail:
        typeof body.responsibleEmail === "string"
          ? body.responsibleEmail
          : null,
      projectRef: typeof body.projectRef === "string" ? body.projectRef : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      createdByEmail: userEmail,
    });
    return NextResponse.json({ goal }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create" },
      { status: 500 },
    );
  }
}
