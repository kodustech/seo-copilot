"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Auto-add: point a saved CRM filter at this sequence and let the cron enrol
// whoever it matches, hourly.
//
// The filters are the same ones the accounts list offers, so a rule means the
// same thing the list meant. Nothing here decides who is safe to contact —
// enrollFromCrm still suppresses paying and closed accounts and skips anyone
// already sequenced.
// ---------------------------------------------------------------------------

type Rule = {
  id: string;
  name: string | null;
  filters: Record<string, unknown>;
  active: boolean;
  maxPerRun: number;
  allContacts: boolean;
  lastRunAt: string | null;
  lastResult: { enrolled?: number; matched?: number } | null;
};

const TIERS = ["t0", "t1", "t2", "t3"];
const STATUSES = ["lead", "engaged", "qualified", "poc", "negotiation"];

export function AutoEnrollDialog({
  sequenceId,
  sequenceName,
  authFetch,
}: {
  sequenceId: string;
  sequenceName: string;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [tier, setTier] = useState("all");
  const [status, setStatus] = useState("lead");
  const [maxPerRun, setMaxPerRun] = useState(10);
  // Preview is required before a rule can go live: how many accounts a filter
  // matches is not obvious from reading it, and the first run sends real email.
  const [preview, setPreview] = useState<{
    matched: number;
    attempted: number;
    scanTruncated?: boolean;
  } | null>(null);

  const filters = useCallback(() => {
    const f: Record<string, unknown> = {};
    if (tier !== "all") f.tier = tier;
    if (status !== "all") f.status = status;
    return f;
  }, [tier, status]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/outreach/sequences/${sequenceId}/auto-enroll`);
      const json = await res.json();
      setRules(json.rules ?? []);
    } finally {
      setLoading(false);
    }
  }, [authFetch, sequenceId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Any change to the filter invalidates the preview it produced.
  useEffect(() => setPreview(null), [tier, status]);

  const runPreview = async () => {
    setErr(null);
    setSaving(true);
    try {
      const res = await authFetch(`/api/outreach/sequences/${sequenceId}/auto-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview: true, filters: filters(), maxPerRun }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Preview failed");
      setPreview(json.preview);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setSaving(false);
    }
  };

  const save = async (active: boolean) => {
    setErr(null);
    setSaving(true);
    try {
      const res = await authFetch(`/api/outreach/sequences/${sequenceId}/auto-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: filters(),
          active,
          maxPerRun,
          name: `${status !== "all" ? status : "any"}${tier !== "all" ? ` · ${tier}` : ""}`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setPreview(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule: Rule) => {
    setSaving(true);
    try {
      await authFetch(`/api/outreach/sequences/${sequenceId}/auto-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rule, active: !rule.active }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ruleId: string) => {
    setSaving(true);
    try {
      await authFetch(
        `/api/outreach/sequences/${sequenceId}/auto-enroll?ruleId=${ruleId}`,
        { method: "DELETE" },
      );
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        title="Auto-add accounts from the CRM"
      >
        <Zap className="size-3.5" />
        Auto-add
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Auto-add from CRM</DialogTitle>
            <DialogDescription>
              Accounts matching this filter are enrolled in{" "}
              <span className="font-medium text-foreground">{sequenceName}</span>{" "}
              every hour. Paying and closed accounts are never enrolled, and
              neither is anyone already in a sequence.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Status</p>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any</SelectItem>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Tier</p>
                <Select value={tier} onValueChange={setTier}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any</SelectItem>
                    {TIERS.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Max per run</p>
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={maxPerRun}
                  onChange={(e) => setMaxPerRun(Number(e.target.value) || 1)}
                />
              </div>
            </div>

            {preview && (
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                Matches <span className="font-medium text-foreground">{preview.matched}</span>{" "}
                {preview.matched === 1 ? "account" : "accounts"} right now;{" "}
                {preview.attempted} would be enrolled on the next run.
                {preview.matched > preview.attempted && " The cap holds the rest for later runs."}
                {preview.scanTruncated && (
                  <span className="mt-1 block text-amber-400">
                    This filter reaches past what one run scans — narrow it, or
                    accounts at the far end may never be reached.
                  </span>
                )}
              </p>
            )}
            {err && <p className="text-xs text-destructive">{err}</p>}

            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={saving} onClick={() => void runPreview()}>
                {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                Preview
              </Button>
              <Button size="sm" disabled={saving || !preview} onClick={() => void save(true)}>
                Save and turn on
              </Button>
              <Button size="sm" variant="ghost" disabled={saving || !preview} onClick={() => void save(false)}>
                Save off
              </Button>
            </div>

            {loading ? (
              <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
            ) : rules.length > 0 ? (
              <div className="space-y-1 border-t border-border pt-3">
                {rules.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-xs">
                    <Badge variant={r.active ? "default" : "outline"}>
                      {r.active ? "on" : "off"}
                    </Badge>
                    <span className="flex-1 truncate">
                      {r.name ?? JSON.stringify(r.filters)}
                      <span className="text-muted-foreground">
                        {" · max "}{r.maxPerRun}
                        {r.lastResult?.enrolled != null && ` · last run enrolled ${r.lastResult.enrolled}`}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => void toggle(r)}>
                      {r.active ? "Turn off" : "Turn on"}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => void remove(r.id)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
