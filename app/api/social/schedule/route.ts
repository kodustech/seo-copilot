import { NextResponse } from "next/server";

import { fetchSocialAccounts, scheduleSocialPost } from "@/lib/copilot";
import { getSupabaseUserClient } from "@/lib/supabase-server";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function parseSocialAccountIds(payload: unknown): number[] {
  if (!Array.isArray(payload)) return [];

  return Array.from(
    new Set(
      payload
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );
}

function formatAccountLabel(platform: string, username: string) {
  const safePlatform = platform.trim() || "Social";
  const safeUsername = username.trim().replace(/^@+/, "") || "unknown";
  return `${safePlatform} @${safeUsername}`;
}

function formatSelectedAccountsLine(
  selectedIds: number[],
  accounts: { id: number; platform: string; username: string }[],
) {
  const map = new Map(
    accounts.map((account) => [account.id, formatAccountLabel(account.platform, account.username)]),
  );

  const labels = selectedIds.map((id) => map.get(id) ?? `Account #${id}`);
  return `Post-Bridge accounts: ${labels.join(", ")}`;
}

export async function POST(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const body = await safeReadJson(req);
    const caption =
      typeof body.caption === "string" ? body.caption.trim() : "";
    const scheduledAt =
      typeof body.scheduledAt === "string" ? body.scheduledAt : "";
    const socialAccountIds = parseSocialAccountIds(body.socialAccountIds);

    if (!caption || !scheduledAt || !socialAccountIds.length) {
      return NextResponse.json(
        {
          error:
            "Required fields: caption, scheduledAt (ISO string), socialAccountIds (number[]).",
        },
        { status: 400 },
      );
    }

    const scheduledPost = await scheduleSocialPost({
      caption,
      scheduledAt,
      socialAccountIds,
      userEmail,
    });

    const availableAccounts = await fetchSocialAccounts({ userEmail });
    return NextResponse.json(
      {
        post: scheduledPost,
        accountsLabel: formatSelectedAccountsLine(socialAccountIds, availableAccounts),
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function safeReadJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
