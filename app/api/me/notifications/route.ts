import { NextResponse } from "next/server";

import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";
import {
  generateNotificationsForUser,
  listNotifications,
  markAllRead,
} from "@/lib/notifications";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function GET(req: Request) {
  let client;
  let userEmail;
  try {
    ({ client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    ));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unreadOnly") === "true";
    const result = await listNotifications(client, userEmail, { unreadOnly });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load" },
      { status: 500 },
    );
  }
}

// POST { action: "markAllRead" | "generate" }
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

  let action = "markAllRead";
  try {
    const body = await req.json();
    if (body && typeof body.action === "string") action = body.action;
  } catch {
    /* default action */
  }

  try {
    if (action === "generate") {
      // Inserts require the service-role client (no INSERT policy for users),
      // but we scope generation to the authenticated user's own email.
      const service = getSupabaseServiceClient();
      const res = await generateNotificationsForUser(service, userEmail);
      const list = await listNotifications(client, userEmail);
      return NextResponse.json({ ...list, created: res.created });
    }
    await markAllRead(client, userEmail);
    const list = await listNotifications(client, userEmail);
    return NextResponse.json(list);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 500 },
    );
  }
}
