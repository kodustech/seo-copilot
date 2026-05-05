import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  deleteProspect,
  PROSPECT_PRIORITIES,
  PROSPECT_STATUSES,
  PROSPECT_TARGET_TYPES,
  updateProspect,
  type UpdateProspectInput,
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
  const updates: UpdateProspectInput = {};

  if (typeof body.domain === "string") updates.domain = body.domain;
  if ("url" in body) updates.url = typeof body.url === "string" ? body.url : null;
  if (typeof body.targetType === "string" && TARGET_SET.has(body.targetType)) {
    updates.targetType = body.targetType as ProspectTargetType;
  }
  if ("contactName" in body)
    updates.contactName =
      typeof body.contactName === "string" ? body.contactName : null;
  if ("contactEmail" in body)
    updates.contactEmail =
      typeof body.contactEmail === "string" ? body.contactEmail : null;
  if ("contactUrl" in body)
    updates.contactUrl =
      typeof body.contactUrl === "string" ? body.contactUrl : null;
  if ("dr" in body)
    updates.dr = typeof body.dr === "number" ? body.dr : null;
  if ("niche" in body)
    updates.niche = typeof body.niche === "string" ? body.niche : null;
  if (typeof body.status === "string" && STATUS_SET.has(body.status)) {
    updates.status = body.status as ProspectStatus;
  }
  if (typeof body.priority === "string" && PRIORITY_SET.has(body.priority)) {
    updates.priority = body.priority as ProspectPriority;
  }
  if ("lastTouchAt" in body)
    updates.lastTouchAt =
      typeof body.lastTouchAt === "string" ? body.lastTouchAt : null;
  if ("nextFollowupAt" in body)
    updates.nextFollowupAt =
      typeof body.nextFollowupAt === "string" ? body.nextFollowupAt : null;
  if ("notes" in body)
    updates.notes = typeof body.notes === "string" ? body.notes : null;
  if ("responsibleEmail" in body)
    updates.responsibleEmail =
      typeof body.responsibleEmail === "string"
        ? body.responsibleEmail
        : null;

  try {
    const prospect = await updateProspect(client, id, updates);
    return NextResponse.json({ prospect });
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
    await deleteProspect(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete" },
      { status: 500 },
    );
  }
}
