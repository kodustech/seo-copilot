import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  COMPANY_PRIORITIES,
  COMPANY_STATUSES,
  createCompany,
  getCompanyStats,
  listCompanies,
  type CompanyFilters,
  type CompanyPriority,
  type CompanyStatus,
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
    const priority = url.searchParams.get("priority");
    const ownerEmail = url.searchParams.get("ownerEmail");
    const search = url.searchParams.get("search");
    const staleOnly = url.searchParams.get("staleOnly") === "true";
    const limit = Number(url.searchParams.get("limit")) || 300;

    const filters: CompanyFilters = { limit, staleOnly };
    if (status && STATUS_SET.has(status)) filters.status = status as CompanyStatus;
    if (priority && PRIORITY_SET.has(priority))
      filters.priority = priority as CompanyPriority;
    if (ownerEmail) filters.ownerEmail = ownerEmail;
    if (search) filters.search = search;

    const [companies, stats] = await Promise.all([
      listCompanies(client, filters),
      getCompanyStats(client),
    ]);
    return NextResponse.json({ companies, stats });
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
  const name = typeof body.name === "string" ? body.name : null;
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const status =
    typeof body.status === "string" && STATUS_SET.has(body.status)
      ? (body.status as CompanyStatus)
      : undefined;
  const priority =
    typeof body.priority === "string" && PRIORITY_SET.has(body.priority)
      ? (body.priority as CompanyPriority)
      : undefined;

  try {
    const company = await createCompany(client, {
      name,
      domain: typeof body.domain === "string" ? body.domain : null,
      orgId: typeof body.orgId === "string" ? body.orgId : null,
      status,
      priority,
      ownerEmail:
        typeof body.ownerEmail === "string" ? body.ownerEmail : null,
      industry: typeof body.industry === "string" ? body.industry : null,
      size: typeof body.size === "string" ? body.size : null,
      country: typeof body.country === "string" ? body.country : null,
      website: typeof body.website === "string" ? body.website : null,
      linkedin: typeof body.linkedin === "string" ? body.linkedin : null,
      arr: typeof body.arr === "number" ? body.arr : null,
      tags: Array.isArray(body.tags)
        ? (body.tags.filter((t) => typeof t === "string") as string[])
        : undefined,
      notes: typeof body.notes === "string" ? body.notes : null,
      createdByEmail: userEmail,
    });
    return NextResponse.json({ company }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create" },
      { status: 500 },
    );
  }
}
