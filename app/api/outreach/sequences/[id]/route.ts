import { NextResponse } from "next/server";

import {
  deleteSequence,
  getSequence,
  getSequenceHealth,
  listEnrollments,
  replaceSteps,
  updateSequence,
} from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const detail = await getSequence(client, id);
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const [enrollments, health] = await Promise.all([
      listEnrollments(client, id),
      getSequenceHealth(client, id),
    ]);
    return NextResponse.json({ ...detail, enrollments, health });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    if (Array.isArray(body.steps)) {
      const steps = await replaceSteps(client, id, body.steps);
      const sequence = await updateSequence(client, id, {
        name: body.name,
        description: body.description,
        status: body.status,
        defaultFromEmail: body.defaultFromEmail,
        mailboxId: body.mailboxId,
      }).catch(async () => {
        const d = await getSequence(client, id);
        return d!.sequence;
      });
      return NextResponse.json({ sequence, steps });
    }

    const sequence = await updateSequence(client, id, {
      name: body.name,
      description: body.description,
      status: body.status,
      defaultFromEmail: body.defaultFromEmail,
      mailboxId: body.mailboxId,
    });
    return NextResponse.json({ sequence });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const result = await deleteSequence(client, id);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    const status = msg === "Sequence not found" ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
