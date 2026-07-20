import { NextResponse } from "next/server";

import { isAllowedEmail, revokePersonalToken } from "@/lib/mcp/tokens";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

/** DELETE /api/mcp/tokens/[id] — revoke own personal MCP token. */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const {
      data: { user },
      error,
    } = await client.auth.getUser();
    if (error || !user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isAllowedEmail(userEmail)) {
      return NextResponse.json(
        { error: "Email domain not allowed" },
        { status: 403 },
      );
    }

    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json({ error: "Missing token id" }, { status: 400 });
    }

    const service = getSupabaseServiceClient();
    await revokePersonalToken(service, user.id, id);
    return NextResponse.json({ ok: true, revoked: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to revoke";
    const status = message.includes("not found") ? 404 : 401;
    return NextResponse.json({ error: message }, { status });
  }
}
