import { NextResponse } from "next/server";

import { promoteEnrollmentToCrm } from "@/lib/crm";
import {
  getEnrollment,
  setEnrollmentPaused,
} from "@/lib/outreach/sequences";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

type Ctx = {
  params: Promise<{ id: string; enrollmentId: string }>;
};

/**
 * PATCH — pause/resume, or promote to CRM.
 * Body:
 *   { status: "paused" | "active", reason?: string }
 *   { action: "promote_crm" }
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { enrollmentId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      status?: string;
      reason?: string;
      action?: string;
    };

    if (body.action === "promote_crm") {
      // Service role so CRM write is reliable (same as other CRM handoffs).
      const service = getSupabaseServiceClient();
      const enrollment =
        (await getEnrollment(service, enrollmentId)) ??
        (await getEnrollment(client, enrollmentId));
      if (!enrollment) {
        return NextResponse.json(
          { error: "Enrollment not found" },
          { status: 404 },
        );
      }
      const result = await promoteEnrollmentToCrm(service, enrollment, {
        reason: "manual_promote",
        actorEmail: userEmail,
      });
      if (result.skipped || !result.company) {
        return NextResponse.json(
          { error: result.skipped ?? "Could not promote to CRM" },
          { status: 400 },
        );
      }
      return NextResponse.json({
        companyId: result.company.id,
        created: result.created,
        contactCreated: result.contactCreated,
        company: result.company,
      });
    }

    if (body.status !== "paused" && body.status !== "active") {
      return NextResponse.json(
        {
          error:
            'status must be "paused" | "active", or action "promote_crm"',
        },
        { status: 400 },
      );
    }

    const enrollment = await setEnrollmentPaused(
      client,
      enrollmentId,
      body.status === "paused",
      { reason: body.reason ?? null },
    );

    return NextResponse.json({ enrollment });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    const status = /not found/i.test(message)
      ? 404
      : /cannot pause/i.test(message)
        ? 400
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
