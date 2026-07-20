import { NextResponse } from "next/server";

import {
  createColumn,
  deleteColumn,
  listColumns,
  runColumn,
  updateColumn,
} from "@/lib/research/columns";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

/** GET — list columns for a table (id or slug in path). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const result = await listColumns(client, id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

/**
 * POST — create column or run enrich.
 * Body { action?: "create" | "run", ... }
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const action = String(body.action ?? "create");

    if (action === "run") {
      const key = String(body.key ?? body.column_key ?? "");
      if (!key) {
        return NextResponse.json({ error: "key required" }, { status: 400 });
      }
      const result = await runColumn(client, id, key, {
        rowIds: Array.isArray(body.rowIds)
          ? (body.rowIds as string[])
          : undefined,
        onlyMissing: body.onlyMissing !== false,
        maxRows:
          typeof body.maxRows === "number" ? body.maxRows : undefined,
      });
      return NextResponse.json(result);
    }

    const label = String(body.label ?? "");
    if (!label.trim()) {
      return NextResponse.json({ error: "label required" }, { status: 400 });
    }
    const result = await createColumn(client, id, {
      key: typeof body.key === "string" ? body.key : undefined,
      label,
      type: body.type as
        | "text"
        | "url"
        | "email"
        | "boolean"
        | "number"
        | undefined,
      enrich: body.enrich,
      order: typeof body.order === "number" ? body.order : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    const status = /not found|Invalid|already exists|required/i.test(msg)
      ? 400
      : 401;
    return NextResponse.json({ error: msg }, { status });
  }
}

/** PATCH — update column by key in body. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json()) as Record<string, unknown>;
    const key = String(body.key ?? "");
    if (!key) {
      return NextResponse.json({ error: "key required" }, { status: 400 });
    }
    const result = await updateColumn(client, id, key, {
      label: typeof body.label === "string" ? body.label : undefined,
      type: body.type as
        | "text"
        | "url"
        | "email"
        | "boolean"
        | "number"
        | undefined,
      enrich: body.enrich,
      order: typeof body.order === "number" ? body.order : undefined,
      newKey: typeof body.newKey === "string" ? body.newKey : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}

/** DELETE — ?key=column_key */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const key = new URL(req.url).searchParams.get("key");
    if (!key) {
      return NextResponse.json({ error: "key query required" }, { status: 400 });
    }
    const purge =
      new URL(req.url).searchParams.get("purgeCells") !== "0";
    const result = await deleteColumn(client, id, key, { purgeCells: purge });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
