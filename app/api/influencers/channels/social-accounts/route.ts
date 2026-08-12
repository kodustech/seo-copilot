import { NextResponse } from "next/server";

import { fetchSocialAccounts } from "@/lib/copilot";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const maxDuration = 30;

// Channel platform → the Post-Bridge platform names that count as the same net.
const PLATFORM_ALIASES: Record<string, string[]> = {
  x: ["x", "twitter"],
  devto: ["devto", "dev.to"],
  blog: ["blog"],
  medium: ["medium"],
  reddit: ["reddit"],
  hackernews: ["hackernews"],
};

/**
 * The user's connected Post-Bridge accounts, for the channel Connect picker.
 * Optionally filtered to the accounts that match a channel platform.
 */
export async function GET(req: Request) {
  try {
    // Authenticate (the accounts themselves come from the workspace Post-Bridge
    // key, not per-user, but we still gate the endpoint behind a valid token).
    await getSupabaseUserClient(req.headers.get("authorization"));

    const url = new URL(req.url);
    const platform = url.searchParams.get("platform")?.toLowerCase() ?? null;

    let accounts = await fetchSocialAccounts();
    if (platform) {
      const aliases = new Set(PLATFORM_ALIASES[platform] ?? [platform]);
      accounts = accounts.filter((a) => aliases.has(a.platform.toLowerCase()));
    }

    return NextResponse.json({ accounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message === "Unauthorized" || message.toLowerCase().includes("token")) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    // Post-Bridge not configured / unreachable: return empty, not a hard error,
    // so the UI can show "no accounts" instead of blowing up.
    return NextResponse.json({ accounts: [], warning: message });
  }
}
