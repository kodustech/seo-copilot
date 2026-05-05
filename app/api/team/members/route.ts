import { NextResponse } from "next/server";

import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

// Returns the list of platform users for assignee pickers (Kanban responsible
// dropdown, filters, etc.). Source of truth is Supabase Auth — no separate
// "team members" table to keep in sync.
//
// Auth-protected so we don't leak the user list publicly. Any signed-in user
// can read; the actual listing happens via the service-role client because
// auth.admin.* is not exposed to anon/authenticated tokens.
export async function GET(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const service = getSupabaseServiceClient();
    const { data, error } = await service.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (error) throw error;

    const members = (data?.users ?? [])
      .filter((u) => u.email)
      .map((u) => {
        const email = u.email as string;
        const fullName =
          (u.user_metadata?.full_name as string | undefined) ||
          (u.user_metadata?.name as string | undefined) ||
          null;
        // Prefer first name from full_name; fall back to the local part of
        // the email so the dropdown stays compact.
        const label =
          (fullName && fullName.split(/\s+/)[0]) ||
          email.split("@")[0].split(".")[0];
        return {
          email,
          label,
          avatarUrl: (u.user_metadata?.avatar_url as string | undefined) ?? null,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    return NextResponse.json({ members });
  } catch (err) {
    console.error("[team/members] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list members" },
      { status: 500 },
    );
  }
}
