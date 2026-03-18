import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  createWorkItem,
  listColumns,
  listWorkItems,
  normalizeWorkItemPriority,
  normalizeWorkItemSource,
  normalizeWorkItemStage,
  normalizeWorkItemType,
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

export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const [items, columns] = await Promise.all([
      listWorkItems(client),
      listColumns(client),
    ]);

    return NextResponse.json({ items, columns });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = await safeReadJson(req);

    const title = typeof body.title === "string" ? body.title : "";
    const description =
      typeof body.description === "string" ? body.description : undefined;
    const sourceRef =
      typeof body.sourceRef === "string" ? body.sourceRef : undefined;
    const link = typeof body.link === "string" ? body.link : undefined;
    const dueAt = typeof body.dueAt === "string" ? body.dueAt : undefined;
    const columnId =
      typeof body.columnId === "string" ? body.columnId : undefined;
    const payload =
      body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : undefined;

    const item = await createWorkItem(client, userEmail, {
      title,
      description,
      itemType: normalizeWorkItemType(body.itemType),
      stage: normalizeWorkItemStage(body.stage),
      columnId,
      source: normalizeWorkItemSource(body.source),
      sourceRef,
      priority: normalizeWorkItemPriority(body.priority),
      link,
      dueAt,
      payload,
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    const status =
      message.includes("required") || message.includes("empty") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
