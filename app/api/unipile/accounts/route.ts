import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  createHostedAuthLink,
  deleteUnipileAccount,
  resetUnipileAccountsCache,
  ensureMessageWebhook,
  isUnipileConfigured,
  listLinkedInAccounts,
  unipileSettingsUrls,
} from "@/lib/unipile";

/**
 * GET — list LinkedIn accounts connected via Unipile + config status.
 */
export async function GET(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  if (!isUnipileConfigured()) {
    return NextResponse.json({
      configured: false,
      accounts: [],
      webhook: null,
    });
  }

  try {
    const [accounts, webhook] = await Promise.all([
      listLinkedInAccounts(),
      ensureMessageWebhook(req).catch((err) => {
        console.warn("[unipile] ensure webhook failed:", err);
        return null;
      }),
    ]);
    return NextResponse.json({
      configured: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        publicIdentifier: a.publicIdentifier,
        username: a.username,
        connectionStatus: a.connectionStatus,
        createdAt: a.createdAt,
      })),
      webhook,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to list accounts",
        configured: true,
        accounts: [],
      },
      { status: 500 },
    );
  }
}

/**
 * POST — start Hosted Auth to connect LinkedIn, or delete an account.
 * Body: { action: "connect" } | { action: "delete", accountId: string }
 */
export async function POST(req: Request) {
  let userEmail: string;
  try {
    ({ userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    ));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  if (!isUnipileConfigured()) {
    return NextResponse.json(
      { error: "Unipile is not configured (UNIPILE_API_KEY / UNIPILE_DSN)" },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    accountId?: string;
  };

  try {
    if (body.action === "delete") {
      if (!body.accountId) {
        return NextResponse.json(
          { error: "accountId required" },
          { status: 400 },
        );
      }
      await deleteUnipileAccount(body.accountId);
      // The cached account list would otherwise keep serving the account we
      // just removed for up to its TTL.
      resetUnipileAccountsCache();
      return NextResponse.json({ ok: true });
    }

    // default: connect
    const urls = unipileSettingsUrls(req);
    await ensureMessageWebhook(req).catch((err) => {
      console.warn("[unipile] ensure webhook on connect failed:", err);
    });
    const { url } = await createHostedAuthLink({
      type: "create",
      userEmail,
      successRedirectUrl: urls.success,
      failureRedirectUrl: urls.failure,
      notifyUrl: urls.notify,
    });
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unipile request failed" },
      { status: 500 },
    );
  }
}
