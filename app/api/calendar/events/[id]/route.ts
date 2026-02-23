import { NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(_req: Request, ctx: Ctx) {
  await ctx.params;
  return NextResponse.json(
    { error: "Manual calendar items are disabled." },
    { status: 410 },
  );
}

export async function DELETE(_req: Request, ctx: Ctx) {
  await ctx.params;
  return NextResponse.json(
    { error: "Manual calendar items are disabled." },
    { status: 410 },
  );
}
