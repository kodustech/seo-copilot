"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type TokenRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type CreateResponse = {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
  note?: string;
  error?: string;
};

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setToken(session?.access_token ?? null);
      },
    );

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [supabase]);

  return token;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function mcpJsonSnippet(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "seo-copilot": {
          type: "http",
          url: "https://growth.kodus.io/api/mcp",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  );
}

export function McpTokenSettings() {
  const token = useAuthToken();
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Claude Code");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "json" | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/tokens", {
        headers: authHeaders(token),
        cache: "no-store",
      });
      const data = (await res.json()) as { tokens?: TokenRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load tokens");
      setRows(data.tokens ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const createToken = async () => {
    if (!token || !name.trim()) return;
    setCreating(true);
    setError(null);
    setFreshToken(null);
    try {
      const res = await fetch("/api/mcp/tokens", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = (await res.json()) as CreateResponse;
      if (!res.ok) throw new Error(data.error ?? "Failed to create");
      setFreshToken(data.token);
      setName("Claude Code");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    if (!token) return;
    if (!confirm("Revoke this token? Agents using it will stop working.")) return;
    setRevokingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/mcp/tokens/${id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to revoke");
      if (freshToken) setFreshToken(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke");
    } finally {
      setRevokingId(null);
    }
  };

  const copy = async (value: string, kind: "token" | "json") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Could not copy to clipboard");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-5 w-5" />
            MCP access
          </CardTitle>
          <CardDescription>
            Personal tokens for Claude Code, Cursor, or other MCP clients.
            Identity is fixed to your account — no shared Bearer needed.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading || !token}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        {freshToken ? (
          <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Copy your token now</p>
                <p className="text-xs text-muted-foreground">
                  It will not be shown again. Store it only in your local{" "}
                  <code className="text-xs">.mcp.json</code>.
                </p>
              </div>
              <Badge variant="secondary">one-time</Badge>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <code className="flex-1 break-all rounded bg-muted px-3 py-2 text-xs">
                {freshToken}
              </code>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void copy(freshToken, "token")}
              >
                {copied === "token" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                <span className="ml-1.5">Copy token</span>
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Paste into growth repo <code>.mcp.json</code>:
              </p>
              <pre className="max-h-48 overflow-auto rounded bg-muted p-3 text-[11px] leading-relaxed">
                {mcpJsonSnippet(freshToken)}
              </pre>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copy(mcpJsonSnippet(freshToken), "json")}
              >
                {copied === "json" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                <span className="ml-1.5">Copy .mcp.json</span>
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Token name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Code laptop"
              maxLength={80}
              disabled={creating || !token}
            />
          </div>
          <Button
            type="button"
            onClick={() => void createToken()}
            disabled={creating || !token || !name.trim()}
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            <span className="ml-1.5">Create token</span>
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Your tokens</p>
          {loading && rows.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active tokens. Create one to connect Claude Code or Cursor.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.name}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                        {row.tokenPrefix}…
                      </code>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Created {formatDate(row.createdAt)}
                      {" · "}
                      Last used {formatDate(row.lastUsedAt)}
                      {row.expiresAt
                        ? ` · Expires ${formatDate(row.expiresAt)}`
                        : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={revokingId === row.id}
                    onClick={() => void revoke(row.id)}
                  >
                    {revokingId === row.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    <span className="ml-1.5">Revoke</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
