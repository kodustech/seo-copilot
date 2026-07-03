import { NextResponse } from "next/server";

import { getSupabaseServiceClient } from "@/lib/supabase-server";
import {
  COMPANY_STATUSES,
  upsertCompanyFromWebhook,
  type CompanyStatus,
  type CreateCompanyInput,
} from "@/lib/crm";

export const maxDuration = 60;

const STATUS_SET = new Set<string>(COMPANY_STATUSES);

// ---------------------------------------------------------------------------
// Enrichment webhook. External flows (n8n) POST a company payload; we upsert
// idempotently by org_id, then domain. Auth via a dedicated bearer secret.
//
//   curl -X POST https://<app>/api/crm/webhook \
//     -H "Authorization: Bearer $CRM_WEBHOOK_SECRET" \
//     -H "Content-Type: application/json" \
//     -d '{"name":"Acme","domain":"acme.com","orgId":"...","industry":"SaaS",
//          "enrichment":{"employees":120,"stack":["node"]}}'
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const secret = process.env.CRM_WEBHOOK_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name : null;
  const domain = typeof body.domain === "string" ? body.domain : null;
  const orgId = typeof body.orgId === "string" ? body.orgId : null;

  // Need at least one identity + a name (derive name from domain if missing).
  if (!orgId && !domain) {
    return NextResponse.json(
      { error: "Provide at least orgId or domain" },
      { status: 400 },
    );
  }
  const resolvedName = name ?? domain ?? orgId ?? "Unknown";

  const status =
    typeof body.status === "string" && STATUS_SET.has(body.status)
      ? (body.status as CompanyStatus)
      : undefined;

  const input: CreateCompanyInput = {
    name: resolvedName,
    domain,
    orgId,
    status,
    industry: typeof body.industry === "string" ? body.industry : null,
    size: typeof body.size === "string" ? body.size : null,
    country: typeof body.country === "string" ? body.country : null,
    website: typeof body.website === "string" ? body.website : null,
    linkedin: typeof body.linkedin === "string" ? body.linkedin : null,
    tags: Array.isArray(body.tags)
      ? (body.tags.filter((t) => typeof t === "string") as string[])
      : undefined,
    enrichment:
      body.enrichment && typeof body.enrichment === "object" && !Array.isArray(body.enrichment)
        ? (body.enrichment as Record<string, unknown>)
        : undefined,
    source: "webhook",
  };

  try {
    // Service-role client bypasses RLS — the webhook is not an authed user.
    const client = getSupabaseServiceClient();
    const { company, created } = await upsertCompanyFromWebhook(client, input);
    return NextResponse.json(
      { ok: true, created, companyId: company.id, company },
      { status: created ? 201 : 200 },
    );
  } catch (err) {
    console.error("[crm/webhook] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to upsert" },
      { status: 500 },
    );
  }
}
