"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Types mirrored from the API payloads
// ---------------------------------------------------------------------------

type Signal = {
  id: string;
  watchlistId: string;
  companyId: string | null;
  signalType: string;
  strength: "strong" | "medium";
  title: string;
  url: string;
  evidence: string | null;
  detectedAt: string;
  companyName: string;
  domain: string | null;
};

type WatchlistEntry = {
  id: string;
  companyName: string;
  domain: string | null;
  ats: string;
  boardSlug: string;
  active: boolean;
  lastScannedAt: string | null;
};

const SIGNAL_LABELS: Record<string, string> = {
  qa_automation_hiring: "QA automation hiring",
  test_suite_rescue: "Test suite rescue",
  ai_feature: "AI feature",
  e2e_tooling: "E2E tooling",
  dev_hiring_no_qa: "Dev hiring, no QA",
};

function boardUrl(entry: { ats: string; boardSlug: string }): string {
  switch (entry.ats) {
    case "greenhouse":
      return `https://boards.greenhouse.io/${entry.boardSlug}`;
    case "lever":
      return `https://jobs.lever.co/${entry.boardSlug}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${entry.boardSlug}`;
    default:
      return "#";
  }
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function IcpProspectsPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<"discover" | "scan" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [signalsRes, watchlistRes] = await Promise.all([
        fetch("/api/icp/signals", { headers }),
        fetch("/api/icp/watchlist", { headers }),
      ]);
      if (signalsRes.ok) {
        setSignals(((await signalsRes.json()).signals ?? []) as Signal[]);
      }
      if (watchlistRes.ok) {
        setWatchlist(((await watchlistRes.json()).entries ?? []) as WatchlistEntry[]);
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runAction = useCallback(
    async (action: "discover" | "scan") => {
      if (!token || running) return;
      setRunning(action);
      setNotice(null);
      try {
        const res = await fetch(`/api/icp/${action}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) {
          setNotice(data.error ?? `${action} failed`);
        } else if (action === "discover") {
          setNotice(
            `Discovered ${data.discovered} companies (${data.added} on watchlist)` +
              (data.scan ? `, ${data.scan.newSignals} new signals` : ""),
          );
        } else {
          setNotice(
            `Scanned ${data.companiesScanned} companies, ${data.newSignals} new signals`,
          );
        }
        await reload();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : `${action} failed`);
      } finally {
        setRunning(null);
      }
    },
    [token, running, reload],
  );

  // Group signals by company for the prospect view.
  const companies = useMemo(() => {
    const map = new Map<
      string,
      { companyName: string; domain: string | null; companyId: string | null; signals: Signal[] }
    >();
    for (const s of signals) {
      const key = s.watchlistId;
      if (!map.has(key)) {
        map.set(key, {
          companyName: s.companyName,
          domain: s.domain,
          companyId: s.companyId,
          signals: [],
        });
      }
      map.get(key)!.signals.push(s);
    }
    return Array.from(map.values()).sort((a, b) => {
      const strongA = a.signals.filter((s) => s.strength === "strong").length;
      const strongB = b.signals.filter((s) => s.strength === "strong").length;
      return strongB - strongA;
    });
  }, [signals]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">ICP Prospects</h1>
          <p className="text-sm text-muted-foreground">
            Companies discovered from public job boards, ranked by buying-intent
            signals. Discovery runs Mondays, scans run daily.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runAction("scan")}
            disabled={!token || running !== null}
          >
            {running === "scan" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            Scan now
          </Button>
          <Button
            size="sm"
            onClick={() => void runAction("discover")}
            disabled={!token || running !== null}
          >
            {running === "discover" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-1.5 h-4 w-4" />
            )}
            Discover companies
          </Button>
        </div>
      </div>

      {notice ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </div>
      ) : null}

      <Tabs defaultValue="prospects">
        <TabsList>
          <TabsTrigger value="prospects">
            Prospects ({companies.length})
          </TabsTrigger>
          <TabsTrigger value="watchlist">
            Watchlist ({watchlist.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prospects" className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading signals...
            </div>
          ) : companies.length === 0 ? (
            <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
              <Sparkles className="mx-auto mb-2 h-5 w-5" />
              No signals yet. Hit “Discover companies” to build the first
              prospect list from live QA/E2E job postings.
            </div>
          ) : (
            companies.map((company) => (
              <div
                key={company.companyName}
                className="rounded-lg border border-border p-4"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{company.companyName}</span>
                  {company.domain ? (
                    <a
                      href={`https://${company.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      {company.domain}
                    </a>
                  ) : null}
                  {company.companyId ? (
                    <Badge className="bg-emerald-500/20 text-emerald-300">
                      in CRM
                    </Badge>
                  ) : null}
                </div>
                <ul className="space-y-2">
                  {company.signals.map((s) => (
                    <li key={s.id} className="text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          className={cn(
                            s.strength === "strong"
                              ? "bg-red-500/20 text-red-300"
                              : "bg-amber-500/20 text-amber-300",
                          )}
                        >
                          {SIGNAL_LABELS[s.signalType] ?? s.signalType}
                        </Badge>
                        {s.url.startsWith("http") ? (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:underline"
                          >
                            {s.title}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span>{s.title}</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatDate(s.detectedAt)}
                        </span>
                      </div>
                      {s.evidence ? (
                        <p className="mt-1 pl-1 text-xs text-muted-foreground">
                          “{s.evidence}”
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="watchlist">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Board</TableHead>
                <TableHead>Last scanned</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {watchlist.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-medium">
                    {entry.companyName}
                    {entry.domain ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {entry.domain}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <a
                      href={boardUrl(entry)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm hover:underline"
                    >
                      {entry.ats}/{entry.boardSlug}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(entry.lastScannedAt)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={cn(
                        entry.active
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-neutral-500/20 text-neutral-300",
                      )}
                    >
                      {entry.active ? "active" : "paused"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </div>
  );
}
