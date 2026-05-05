import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  createProspect,
  getProspectStats,
  listProspects,
  PROSPECT_PRIORITIES,
  PROSPECT_STATUSES,
  PROSPECT_TARGET_TYPES,
  type ProspectFilters,
  type ProspectStatus,
  type ProspectTargetType,
  type ProspectPriority,
} from "@/lib/outreach";

const STATUS_SET = new Set<string>(PROSPECT_STATUSES);
const TARGET_SET = new Set<string>(PROSPECT_TARGET_TYPES);
const PRIORITY_SET = new Set<string>(PROSPECT_PRIORITIES);

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
    const targetType = url.searchParams.get("targetType");
    const responsibleEmail = url.searchParams.get("responsibleEmail");
    const search = url.searchParams.get("search");
    const limit = Number(url.searchParams.get("limit")) || 200;

    const filters: ProspectFilters = { limit };
    if (status && STATUS_SET.has(status)) {
      filters.status = status as ProspectStatus;
    }
    if (targetType && TARGET_SET.has(targetType)) {
      filters.targetType = targetType as ProspectTargetType;
    }
    if (responsibleEmail) filters.responsibleEmail = responsibleEmail;
    if (search) filters.search = search;

    const [prospects, stats] = await Promise.all([
      listProspects(client, filters),
      getProspectStats(client),
    ]);
    return NextResponse.json({ prospects, stats });
  } catch (err) {
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
  const domain = typeof body.domain === "string" ? body.domain : null;
  const targetType =
    typeof body.targetType === "string" && TARGET_SET.has(body.targetType)
      ? (body.targetType as ProspectTargetType)
      : null;

  if (!domain) {
    return NextResponse.json(
      { error: "domain is required" },
      { status: 400 },
    );
  }
  if (!targetType) {
    return NextResponse.json(
      { error: "targetType must be one of: " + PROSPECT_TARGET_TYPES.join(", ") },
      { status: 400 },
    );
  }

  const status =
    typeof body.status === "string" && STATUS_SET.has(body.status)
      ? (body.status as ProspectStatus)
      : undefined;
  const priority =
    typeof body.priority === "string" && PRIORITY_SET.has(body.priority)
      ? (body.priority as ProspectPriority)
      : undefined;

  try {
    const prospect = await createProspect(client, {
      domain,
      url: typeof body.url === "string" ? body.url : null,
      targetType,
      contactName: typeof body.contactName === "string" ? body.contactName : null,
      contactEmail:
        typeof body.contactEmail === "string" ? body.contactEmail : null,
      contactUrl: typeof body.contactUrl === "string" ? body.contactUrl : null,
      dr: typeof body.dr === "number" ? body.dr : null,
      niche: typeof body.niche === "string" ? body.niche : null,
      status,
      priority,
      lastTouchAt:
        typeof body.lastTouchAt === "string" ? body.lastTouchAt : null,
      nextFollowupAt:
        typeof body.nextFollowupAt === "string" ? body.nextFollowupAt : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      responsibleEmail:
        typeof body.responsibleEmail === "string"
          ? body.responsibleEmail
          : null,
      source: typeof body.source === "string" ? body.source : null,
      sourceMentionId:
        typeof body.sourceMentionId === "string" ? body.sourceMentionId : null,
      createdByEmail: userEmail,
    });
    return NextResponse.json({ prospect }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create" },
      { status: 500 },
    );
  }
}
