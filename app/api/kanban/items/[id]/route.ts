import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  normalizeWorkItemPriority,
  normalizeWorkItemSource,
  normalizeWorkItemStage,
  normalizeWorkItemType,
  updateWorkItem,
} from "@/lib/kanban";

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

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing item id." }, { status: 400 });
  }

  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = await safeReadJson(req);

    const updates: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "title")) {
      updates.title = typeof body.title === "string" ? body.title : "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      updates.description =
        typeof body.description === "string" ? body.description : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "itemType")) {
      updates.itemType = normalizeWorkItemType(body.itemType);
    }
    if (Object.prototype.hasOwnProperty.call(body, "stage")) {
      updates.stage = normalizeWorkItemStage(body.stage);
    }
    if (Object.prototype.hasOwnProperty.call(body, "source")) {
      updates.source = normalizeWorkItemSource(body.source);
    }
    if (Object.prototype.hasOwnProperty.call(body, "sourceRef")) {
      updates.sourceRef =
        typeof body.sourceRef === "string" ? body.sourceRef : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "priority")) {
      updates.priority = normalizeWorkItemPriority(body.priority);
    }
    if (Object.prototype.hasOwnProperty.call(body, "link")) {
      updates.link = typeof body.link === "string" ? body.link : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "dueAt")) {
      updates.dueAt = typeof body.dueAt === "string" ? body.dueAt : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "payload")) {
      updates.payload =
        body.payload &&
        typeof body.payload === "object" &&
        !Array.isArray(body.payload)
          ? body.payload
          : {};
    }

    if (!Object.keys(updates).length) {
      return NextResponse.json(
        { error: "No valid fields to update." },
        { status: 400 },
      );
    }

    const item = await updateWorkItem(
      client,
      userEmail,
      id,
      updates,
    );
    return NextResponse.json({ item });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    const status =
      message.includes("valid updates") || message.includes("empty") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
