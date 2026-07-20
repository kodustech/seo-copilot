"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Mail,
  PlugZap,
  Save,
  Trash2,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
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
import { Switch } from "@/components/ui/switch";

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
  provider: "smtp" | "gmail" | "google_oauth";
  authMethod: "smtp" | "oauth";
  smtpHost: string;
  smtpPort: number;
  smtpUser: string | null;
  connected: boolean;
  hasPassword: boolean;
  dailyCap: number;
  emailAutoSend?: boolean;
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

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function OutreachMailboxSettings() {
  const token = useAuthToken();
  const searchParams = useSearchParams();
  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const [mailbox, setMailbox] = useState<Mailbox | null>(null);
  const [googleOAuthConfigured, setGoogleOAuthConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSmtp, setShowSmtp] = useState(false);

  const [fromName, setFromName] = useState("");
  const [dailyCap, setDailyCap] = useState("40");
  const [emailAutoSend, setEmailAutoSend] = useState(true);
  const [smtpFromEmail, setSmtpFromEmail] = useState("");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpHost, setSmtpHost] = useState("smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState("587");

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
      setGoogleOAuthConfigured(data.googleOAuthConfigured !== false);
      const m = (data.mailboxes as Mailbox[])?.[0] ?? null;
      setMailbox(m);
      if (m) {
        setFromName(m.fromName ?? "");
        setDailyCap(String(m.dailyCap));
        setEmailAutoSend(m.emailAutoSend !== false);
        setSmtpFromEmail(m.fromEmail);
        setSmtpUser(m.smtpUser ?? m.fromEmail);
        setSmtpHost(m.smtpHost);
        setSmtpPort(String(m.smtpPort));
        if (m.authMethod === "smtp") setShowSmtp(true);
      }
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const status = searchParams.get("mailbox");
    if (!status) return;
    if (status === "connected") {
      const email = searchParams.get("email");
      setNotice(
        email
          ? `Connected ${email}. Sequences will send from this Gmail.`
          : "Google mailbox connected.",
      );
      void load();
    } else if (status === "error") {
      setError(
        searchParams.get("reason") ?? "Google connection failed",
      );
    }
  }, [searchParams, load]);

  const connectGoogle = async () => {
    if (!token) return;
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/outreach/mailbox/google/start", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          fromName: fromName || undefined,
          dailyCap: Number(dailyCap) || 40,
          label: "Outreach",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not start Google sign-in");
        return;
      }
      window.location.href = data.url as string;
    } finally {
      setConnecting(false);
    }
  };

  const saveMeta = async () => {
    if (!token || !mailbox?.id) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/outreach/mailbox", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          metaOnly: true,
          id: mailbox.id,
          fromName: fromName || null,
          dailyCap: Number(dailyCap) || 40,
          emailAutoSend,
          label: mailbox.label,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setMailbox(data.mailbox);
      setEmailAutoSend(data.mailbox?.emailAutoSend !== false);
      setNotice("Saved.");
    } finally {
      setSaving(false);
    }
  };

  const saveSmtp = async () => {
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/outreach/mailbox", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          id: mailbox?.authMethod === "smtp" ? mailbox.id : undefined,
          label: "Outreach",
          fromName: fromName || null,
          fromEmail: smtpFromEmail,
          provider: "gmail",
          smtpHost,
          smtpPort: Number(smtpPort) || 587,
          smtpUser: smtpUser || smtpFromEmail,
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
      setNotice("SMTP mailbox saved.");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!token || !mailbox?.id) {
      setError("Connect a mailbox first.");
      return;
    }
    setTesting(true);
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
      setNotice("Connection OK.");
      await load();
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!token || !mailbox?.id) return;
    if (!confirm("Disconnect this outreach mailbox?")) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/outreach/mailbox?id=${encodeURIComponent(mailbox.id)}`,
        { method: "DELETE", headers: headers() },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Disconnect failed");
        return;
      }
      setMailbox(null);
      setNotice("Mailbox disconnected.");
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
          <CardDescription>Sign in to connect a mailbox.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const isOauthConnected =
    mailbox?.connected &&
    (mailbox.authMethod === "oauth" || mailbox.provider === "google_oauth");

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
              Connect the Gmail / Workspace inbox used by sequences. One click
              with Google — no app password.
            </CardDescription>
          </div>
          {mailbox?.connected && (
            <div className="flex flex-wrap gap-1.5">
              {mailbox.lastTestOk === true && (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="size-3" />
                  Connected
                </Badge>
              )}
              {mailbox.lastTestOk === false && (
                <Badge variant="destructive">Needs reconnect</Badge>
              )}
              <Badge variant="outline">
                {mailbox.sentToday}/{mailbox.dailyCap} today
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            {isOauthConnected ? (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 px-4 py-3">
                  <div className="text-sm font-medium">{mailbox.fromEmail}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Google OAuth · sequences send as this address
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="from-name">From name</FieldLabel>
                    <Input
                      id="from-name"
                      value={fromName}
                      onChange={(e) => setFromName(e.target.value)}
                      placeholder="Gabriel from Kodus"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="cap">Daily send cap</FieldLabel>
                    <Input
                      id="cap"
                      type="number"
                      min={1}
                      max={500}
                      value={dailyCap}
                      onChange={(e) => setDailyCap(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">Auto-send sequence emails</p>
                    <p className="text-xs text-pretty text-muted-foreground">
                      On: due email steps send from this mailbox alone. Off: they
                      appear in Sequences → Today for you to send manually.
                    </p>
                  </div>
                  <Switch
                    checked={emailAutoSend}
                    onCheckedChange={setEmailAutoSend}
                    aria-label="Auto-send sequence emails"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button disabled={saving} onClick={() => void saveMeta()}>
                    {saving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    disabled={testing}
                    onClick={() => void test()}
                  >
                    {testing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <PlugZap className="size-4" />
                    )}
                    Test
                  </Button>
                  <Button
                    variant="outline"
                    disabled={connecting}
                    onClick={() => void connectGoogle()}
                  >
                    {connecting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <GoogleIcon className="size-4" />
                    )}
                    Reconnect Google
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => void remove()}
                  >
                    <Trash2 className="size-4" />
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="from-name-pre">
                      From name (optional)
                    </FieldLabel>
                    <Input
                      id="from-name-pre"
                      value={fromName}
                      onChange={(e) => setFromName(e.target.value)}
                      placeholder="Gabriel from Kodus"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="cap-pre">Daily send cap</FieldLabel>
                    <Input
                      id="cap-pre"
                      type="number"
                      min={1}
                      max={500}
                      value={dailyCap}
                      onChange={(e) => setDailyCap(e.target.value)}
                    />
                  </div>
                </div>

                <Button
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={connecting || !googleOAuthConfigured}
                  onClick={() => void connectGoogle()}
                >
                  {connecting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <GoogleIcon className="size-4" />
                  )}
                  Connect with Google
                </Button>

                {!googleOAuthConfigured && (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    Server missing{" "}
                    <code className="text-xs">GOOGLE_OAUTH_CLIENT_ID</code> /{" "}
                    <code className="text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code>.
                    Add them in Railway, or use SMTP below.
                  </p>
                )}

                <p className="text-xs text-muted-foreground">
                  You&apos;ll approve Gmail send access for the outreach
                  mailbox. Tokens are encrypted; we never store your Google
                  password.
                </p>
              </div>
            )}

            {/* Advanced SMTP fallback */}
            <div className="border-t pt-3">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center justify-between text-left text-sm text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setShowSmtp((v) => !v)}
              >
                <span>Advanced: SMTP / app password</span>
                {showSmtp ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
              </button>
              {showSmtp && (
                <div className="mt-3 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <FieldLabel htmlFor="smtp-email">From email</FieldLabel>
                      <Input
                        id="smtp-email"
                        value={smtpFromEmail}
                        onChange={(e) => {
                          setSmtpFromEmail(e.target.value);
                          if (!smtpUser) setSmtpUser(e.target.value);
                        }}
                        placeholder="outreach@yourdomain.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <FieldLabel htmlFor="smtp-user">SMTP user</FieldLabel>
                      <Input
                        id="smtp-user"
                        value={smtpUser}
                        onChange={(e) => setSmtpUser(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <FieldLabel htmlFor="smtp-pass">App password</FieldLabel>
                      <Input
                        id="smtp-pass"
                        type="password"
                        autoComplete="new-password"
                        value={smtpPass}
                        onChange={(e) => setSmtpPass(e.target.value)}
                        placeholder="Google App Password"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <FieldLabel htmlFor="smtp-host">Host</FieldLabel>
                      <Input
                        id="smtp-host"
                        value={smtpHost}
                        onChange={(e) => setSmtpHost(e.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    disabled={saving}
                    onClick={() => void saveSmtp()}
                  >
                    {saving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    Save SMTP mailbox
                  </Button>
                </div>
              )}
            </div>

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
          </>
        )}
      </CardContent>
    </Card>
  );
}
