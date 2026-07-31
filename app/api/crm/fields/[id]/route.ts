import { NextResponse } from "next/server";

import {
  CRM_FIELD_TYPES,
  deleteFieldDef,
  getFieldDef,
  updateFieldDef,
  type CrmFieldOption,
  type CrmFieldType,
} from "@/lib/crm-fields";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

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

function parseOptions(raw: unknown): CrmFieldOption[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o) => o && typeof o === "object")
    .map((o) => {
      const r = o as Record<string, unknown>;
      return {
        id: typeof r.id === "string" ? r.id : "",
        label: typeof r.label === "string" ? r.label : "",
      };
    });
}

async function authedService(req: Request) {
  await getSupabaseUserClient(req.headers.get("authorization"));
  return getSupabaseServiceClient();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    client = await authedService(req);
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    const field = await getFieldDef(client, id);
    if (!field) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ field });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load field" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    client = await authedService(req);
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  const body = await safeReadJson(req);
  const input: {
    label?: string;
    type?: CrmFieldType;
    options?: CrmFieldOption[];
    position?: number;
  } = {};

  if (typeof body.label === "string") input.label = body.label;
  if (typeof body.type === "string") {
    if (!CRM_FIELD_TYPES.includes(body.type as CrmFieldType)) {
      return NextResponse.json(
        { error: `type must be one of: ${CRM_FIELD_TYPES.join(", ")}` },
        { status: 400 },
      );
    }
    input.type = body.type as CrmFieldType;
  }
  if ("options" in body) input.options = parseOptions(body.options);
  if (typeof body.position === "number") input.position = body.position;

  try {
    const field = await updateFieldDef(client, id, input);
    return NextResponse.json({ field });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update field";
    const status = msg === "Field not found" ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    client = await authedService(req);
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    const result = await deleteFieldDef(client, id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete field";
    const status = msg === "Field not found" ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
