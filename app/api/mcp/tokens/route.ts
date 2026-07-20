import { NextResponse } from "next/server";

import {
  createPersonalToken,
  isAllowedEmail,
  listPersonalTokens,
} from "@/lib/mcp/tokens";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

async function requireUser(req: Request) {
  const { client, userEmail } = await getSupabaseUserClient(
    req.headers.get("authorization"),
  );
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user?.id) {
    throw new Error("Invalid or expired session");
  }
  if (!isAllowedEmail(userEmail)) {
    throw new Error("Email domain not allowed for MCP tokens");
  }
  return { userId: user.id, userEmail: userEmail.toLowerCase() };
}

/** GET /api/mcp/tokens — list own personal MCP tokens (no secrets). */
export async function GET(req: Request) {
  try {
    const { userId } = await requireUser(req);
    const service = getSupabaseServiceClient();
    const tokens = await listPersonalTokens(service, userId);
    return NextResponse.json({ tokens });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

/**
 * POST /api/mcp/tokens
 * Body: { name: string, expiresInDays?: number | null }
 * Returns full token once.
 */
export async function POST(req: Request) {
  let userId: string;
  let userEmail: string;
  try {
    ({ userId, userEmail } = await requireUser(req));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  let body: { name?: string; expiresInDays?: number | null } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name : "";
  if (!name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const expiresInDays =
    typeof body.expiresInDays === "number" ? body.expiresInDays : null;

  try {
    const service = getSupabaseServiceClient();
    const created = await createPersonalToken(service, {
      userId,
      userEmail,
      name,
      expiresInDays,
    });
    return NextResponse.json(
      {
        token: created.token,
        id: created.id,
        name: created.name,
        tokenPrefix: created.tokenPrefix,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
        note: "Copy the token now. It will not be shown again.",
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create token" },
      { status: 400 },
    );
  }
}
