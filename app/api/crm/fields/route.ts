import { NextResponse } from "next/server";

import {
  CRM_FIELD_TYPES,
  createFieldDef,
  listFieldDefs,
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

/**
 * Auth as the user, then use service role for reads/writes.
 * Avoids silent empty results when table RLS/GRANTs are incomplete
 * (same pattern as mailbox settings).
 */
async function authedService(req: Request) {
  await getSupabaseUserClient(req.headers.get("authorization"));
  return getSupabaseServiceClient();
}

export async function GET(req: Request) {
  let client;
  try {
    client = await authedService(req);
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    const fields = await listFieldDefs(client);
    return NextResponse.json({ fields });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list fields" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  let client;
  try {
    client = await authedService(req);
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  const body = await safeReadJson(req);
  const label = typeof body.label === "string" ? body.label : "";
  const type = body.type as CrmFieldType;
  if (!CRM_FIELD_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type must be one of: ${CRM_FIELD_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const field = await createFieldDef(client, {
      label,
      type,
      key: typeof body.key === "string" ? body.key : undefined,
      options: parseOptions(body.options),
      position: typeof body.position === "number" ? body.position : undefined,
    });
    return NextResponse.json({ field }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create field" },
      { status: 400 },
    );
  }
}
