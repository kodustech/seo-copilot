import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  COMPANY_PRIORITIES,
  COMPANY_STATUSES,
  deleteCompany,
  getCompany,
  listActivities,
  listComments,
  listContacts,
  updateCompany,
  type CompanyPriority,
  type CompanyStatus,
  type UpdateCompanyInput,
} from "@/lib/crm";

const STATUS_SET = new Set<string>(COMPANY_STATUSES);
const PRIORITY_SET = new Set<string>(COMPANY_PRIORITIES);

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

// GET returns the company with its contacts, comments and activity timeline.
export async function GET(
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
    const company = await getCompany(client, id);
    if (!company) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const [contacts, comments, activities] = await Promise.all([
      listContacts(client, id),
      listComments(client, id),
      listActivities(client, id),
    ]);
    return NextResponse.json({ company, contacts, comments, activities });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load" },
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
  let userEmail;
  try {
    ({ client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    ));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  const body = await safeReadJson(req);
  const updates: UpdateCompanyInput = {};

  if (typeof body.name === "string") updates.name = body.name;
  if ("domain" in body)
    updates.domain = typeof body.domain === "string" ? body.domain : null;
  if ("orgId" in body)
    updates.orgId = typeof body.orgId === "string" ? body.orgId : null;
  if (typeof body.status === "string" && STATUS_SET.has(body.status))
    updates.status = body.status as CompanyStatus;
  if (typeof body.priority === "string" && PRIORITY_SET.has(body.priority))
    updates.priority = body.priority as CompanyPriority;
  if ("ownerEmail" in body)
    updates.ownerEmail =
      typeof body.ownerEmail === "string" ? body.ownerEmail : null;
  if ("industry" in body)
    updates.industry = typeof body.industry === "string" ? body.industry : null;
  if ("size" in body)
    updates.size = typeof body.size === "string" ? body.size : null;
  if ("devCount" in body)
    updates.devCount = typeof body.devCount === "number" ? body.devCount : null;
  if ("country" in body)
    updates.country = typeof body.country === "string" ? body.country : null;
  if ("website" in body)
    updates.website = typeof body.website === "string" ? body.website : null;
  if ("linkedin" in body)
    updates.linkedin = typeof body.linkedin === "string" ? body.linkedin : null;
  if ("arr" in body)
    updates.arr = typeof body.arr === "number" ? body.arr : null;
  if (Array.isArray(body.tags))
    updates.tags = body.tags.filter((t) => typeof t === "string") as string[];
  if ("notes" in body)
    updates.notes = typeof body.notes === "string" ? body.notes : null;

  try {
    const company = await updateCompany(client, id, updates, userEmail);
    return NextResponse.json({ company });
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
    await deleteCompany(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete" },
      { status: 500 },
    );
  }
}
