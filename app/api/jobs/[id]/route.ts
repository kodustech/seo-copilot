import { NextResponse } from "next/server";
import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  getJobById,
  deleteJob,
  toggleJob,
  listJobRuns,
} from "@/lib/scheduled-jobs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const job = await getJobById(client, id);
    if (!job || job.user_email !== userEmail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const runs = await listJobRuns(client, id);
    return NextResponse.json({ job, runs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    await deleteJob(client, id, userEmail);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const { enabled } = (await req.json()) as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "Missing required field: enabled (boolean)" },
        { status: 400 },
      );
    }

    const job = await toggleJob(client, id, userEmail, enabled);
    return NextResponse.json({ job });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
