import { NextResponse } from "next/server";

import { fetchSocialAccounts } from "@/lib/copilot";
import { getSupabaseUserClient } from "@/lib/supabase-server";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function GET(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const accounts = await fetchSocialAccounts({ userEmail });
    return NextResponse.json({ accounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
