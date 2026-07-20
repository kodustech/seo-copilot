"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Mail,
  PlugZap,
  Save,
  Trash2,
} from "lucide-react";

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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-xs font-medium text-muted-foreground"
    >
      {children}
    </label>
  );
}

type Mailbox = {
  id: string;
  label: string;
  fromName: string | null;
  fromEmail: string;
  provider: "smtp" | "gmail";
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  hasPassword: boolean;
  dailyCap: number;
  enabled: boolean;
  sentToday: number;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastSentAt: string | null;
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

export function OutreachMailboxSettings() {
  const token = useAuthToken();
  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const [mailbox, setMailbox] = useState<Mailbox | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("Outreach");
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [provider, setProvider] = useState<"gmail" | "smtp">("gmail");
  const [smtpHost, setSmtpHost] = useState("smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [dailyCap, setDailyCap] = useState("40");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/outreach/mailbox", { headers: headers() });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load");
        return;
      }
      const m = (data.mailboxes as Mailbox[])?.[0] ?? null;
      setMailbox(m);
      if (m) {
        setLabel(m.label);
        setFromName(m.fromName ?? "");
        setFromEmail(m.fromEmail);
        setProvider(m.provider === "smtp" ? "smtp" : "gmail");
        setSmtpHost(m.smtpHost);
        setSmtpPort(String(m.smtpPort));
        setSmtpUser(m.smtpUser);
        setDailyCap(String(m.dailyCap));
        setSmtpPass("");
      }
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/outreach/mailbox", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          id: mailbox?.id,
          label,
          fromName: fromName || null,
          fromEmail,
          provider,
          smtpHost: provider === "gmail" ? "smtp.gmail.com" : smtpHost,
          smtpPort: Number(smtpPort) || 587,
          smtpUser: smtpUser || fromEmail,
          smtpPass: smtpPass || undefined,
          dailyCap: Number(dailyCap) || 40,
          isDefault: true,
          enabled: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setMailbox(data.mailbox);
      setSmtpPass("");
      setNotice("Mailbox saved. Run Test connection before enrolling sequences.");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!token || !mailbox?.id) {
      setError("Save the mailbox first, then test.");
      return;
    }
    setTesting(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/outreach/mailbox/test", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ id: mailbox.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Connection test failed");
        await load();
        return;
      }
      setNotice("Connection OK — sequences can send from this mailbox.");
      await load();
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!token || !mailbox?.id) return;
    if (!confirm("Remove this outreach mailbox?")) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/outreach/mailbox?id=${encodeURIComponent(mailbox.id)}`,
        { method: "DELETE", headers: headers() },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Delete failed");
        return;
      }
      setMailbox(null);
      setSmtpPass("");
      setNotice("Mailbox removed.");
    } finally {
      setSaving(false);
    }
  };

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="size-4" />
            Outreach email
          </CardTitle>
          <CardDescription>Sign in to configure the sending mailbox.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="size-4" />
              Outreach email
            </CardTitle>
            <CardDescription className="mt-1">
              Mailbox used by sequences to auto-send email steps. Password is
              encrypted and never shown again after save. Use a Google{" "}
              <span className="font-medium">App Password</span> for Workspace /
              Gmail.
            </CardDescription>
          </div>
          {mailbox && (
            <div className="flex flex-wrap gap-1.5">
              {mailbox.lastTestOk === true && (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="size-3" />
                  Connected
                </Badge>
              )}
              {mailbox.lastTestOk === false && (
                <Badge variant="destructive">Test failed</Badge>
              )}
              <Badge variant="outline">
                {mailbox.sentToday}/{mailbox.dailyCap} today
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FieldLabel htmlFor="mb-label">Label</FieldLabel>
                <Input
                  id="mb-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Outreach"
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Provider</FieldLabel>
                <Select
                  value={provider}
                  onValueChange={(v) => {
                    const p = v as "gmail" | "smtp";
                    setProvider(p);
                    if (p === "gmail") {
                      setSmtpHost("smtp.gmail.com");
                      setSmtpPort("587");
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gmail">
                      Google Workspace / Gmail
                    </SelectItem>
                    <SelectItem value="smtp">Custom SMTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <FieldLabel htmlFor="mb-from-name">From name</FieldLabel>
                <Input
                  id="mb-from-name"
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="Gabriel from Kodus"
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel htmlFor="mb-from-email">From email</FieldLabel>
                <Input
                  id="mb-from-email"
                  type="email"
                  value={fromEmail}
                  onChange={(e) => {
                    setFromEmail(e.target.value);
                    if (!smtpUser) setSmtpUser(e.target.value);
                  }}
                  placeholder="outreach@yourdomain.com"
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel htmlFor="mb-user">SMTP username</FieldLabel>
                <Input
                  id="mb-user"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  placeholder="Usually the same as from email"
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel htmlFor="mb-pass">
                  App password
                  {mailbox?.hasPassword ? " (leave blank to keep)" : ""}
                </FieldLabel>
                <Input
                  id="mb-pass"
                  type="password"
                  autoComplete="new-password"
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  placeholder={
                    mailbox?.hasPassword ? "••••••••••••" : "Google App Password"
                  }
                />
              </div>
              {provider === "smtp" && (
                <>
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="mb-host">SMTP host</FieldLabel>
                    <Input
                      id="mb-host"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="mb-port">Port</FieldLabel>
                    <Input
                      id="mb-port"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="space-y-1.5">
                <FieldLabel htmlFor="mb-cap">Daily send cap</FieldLabel>
                <Input
                  id="mb-cap"
                  type="number"
                  min={1}
                  max={500}
                  value={dailyCap}
                  onChange={(e) => setDailyCap(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Sequences stop sending when the cap is hit (resets daily).
                </p>
              </div>
            </div>

            {mailbox?.lastTestError && mailbox.lastTestOk === false && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                Last test: {mailbox.lastTestError}
              </p>
            )}
            {notice && (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {notice}
              </p>
            )}
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button disabled={saving} onClick={() => void save()}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save mailbox
              </Button>
              <Button
                variant="outline"
                disabled={testing || !mailbox?.id}
                onClick={() => void test()}
              >
                {testing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PlugZap className="size-4" />
                )}
                Test connection
              </Button>
              {mailbox?.id && (
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void remove()}
                >
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Google: Account → Security → 2-Step Verification → App passwords.
              Create one for “Mail” and paste it above. Sequences use this
              mailbox automatically for email steps.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
