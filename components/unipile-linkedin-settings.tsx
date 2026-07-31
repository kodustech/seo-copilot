"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Linkedin, Loader2, PlugZap, Trash2 } from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type LiAccount = {
  id: string;
  type: string;
  name: string | null;
  publicIdentifier: string | null;
  username: string | null;
  connectionStatus: string | null;
  createdAt: string | null;
};

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);
  return token;
}

export function UnipileLinkedInSettings() {
  const token = useAuthToken();
  const searchParams = useSearchParams();
  const [configured, setConfigured] = useState(false);
  const [accounts, setAccounts] = useState<LiAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const headers = useCallback((): Record<string, string> => {
    if (!token) return {};
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }, [token]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/unipile/accounts", { headers: headers() });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed to load");
      setConfigured(Boolean(j.configured));
      setAccounts(j.accounts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const u = searchParams.get("unipile");
    if (u === "connected") {
      setNotice("LinkedIn connected via Unipile.");
      void load();
    } else if (u === "failed") {
      setError("LinkedIn connection failed or was cancelled.");
    }
  }, [searchParams, load]);

  async function connect() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/unipile/accounts", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ action: "connect" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed to start connect");
      if (j.url) {
        window.location.href = j.url as string;
        return;
      }
      throw new Error("No auth URL returned");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
      setBusy(false);
    }
  }

  async function disconnect(accountId: string) {
    if (!token) return;
    if (!confirm("Disconnect this LinkedIn account from Unipile?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/unipile/accounts", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ action: "delete", accountId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed to disconnect");
      setNotice("LinkedIn account disconnected.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Linkedin className="size-4 text-[#0A66C2]" />
          LinkedIn (Unipile)
        </CardTitle>
        <CardDescription>
          Connect LinkedIn so sequence replies can stop the cadence and promote
          the account to CRM — same idea as Gmail reply sync, via Unipile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {!configured && !loading && (
          <p className="text-sm text-muted-foreground">
            Unipile is not configured. Set{" "}
            <code className="text-xs">UNIPILE_API_KEY</code> and{" "}
            <code className="text-xs">UNIPILE_DSN</code> on the server.
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {accounts.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No LinkedIn accounts connected yet.
                </li>
              ) : (
                accounts.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {a.username || a.name || a.publicIdentifier || a.id}
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {a.publicIdentifier
                          ? `linkedin.com/in/${a.publicIdentifier}`
                          : a.id}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {a.connectionStatus && (
                        <Badge variant="secondary" className="text-[10px]">
                          {a.connectionStatus}
                        </Badge>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground"
                        disabled={busy}
                        onClick={() => void disconnect(a.id)}
                        aria-label="Disconnect"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))
              )}
            </ul>

            {configured && (
              <Button
                onClick={() => void connect()}
                disabled={busy}
                className="gap-2"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PlugZap className="size-4" />
                )}
                Connect LinkedIn
              </Button>
            )}

            <p className="text-[11px] text-muted-foreground">
              Inbound DMs on connected accounts trigger reply handling when the
              counterparty matches an enrolled{" "}
              <code className="text-[10px]">contact_linkedin</code> URL. Webhook
              is registered automatically on first load.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
