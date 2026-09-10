"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import {
  AUTOMATION_HINT,
  AUTOMATION_LABEL,
  SectionLabel,
  Status,
  authHeaders,
  channelStateLabel,
  channelTone,
  cls,
  isHandPosted,
  platformLabel,
  type Channel,
} from "./shared";

/**
 * Channels as a ledger: one row per platform with the state that matters
 * (connected or not, how it publishes, the caps), and the connect form behind
 * a chevron. Six channels used to be six tall cards; the page scrolled before
 * it said anything.
 */
export function ChannelsTab({ token, channels, onChanged }: { token: string; channels: Channel[]; onChanged: () => void }) {
  const [openId, setOpenId] = useState<string | null>(() => channels.find((c) => c.status === "pending_setup")?.id ?? null);

  return (
    <section>
      <SectionLabel hint="A channel publishes only within its automation level and daily caps. Open a row to connect it.">
        Channels
      </SectionLabel>
      <div className={cn(cls.panel, "divide-y divide-white/[0.06]")}>
        {channels.map((channel) => (
          <ChannelRow
            key={channel.id}
            token={token}
            channel={channel}
            open={openId === channel.id}
            onToggle={() => setOpenId((id) => (id === channel.id ? null : channel.id))}
            onChanged={onChanged}
          />
        ))}
        {channels.length === 0 ? <p className="px-4 py-6 text-sm text-neutral-500">No channels on this persona.</p> : null}
      </div>
    </section>
  );
}

function ChannelRow({
  token,
  channel,
  open,
  onToggle,
  onChanged,
}: {
  token: string;
  channel: Channel;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [handle, setHandle] = useState(channel.external_handle ?? "");
  const handPosted = isHandPosted(channel);

  // A cleared field is not a request for zero, and "2e" is not a number.
  // Only a finite, non-negative integer reaches the server.
  function patchCap(key: "max_posts_per_day" | "max_replies_per_day", raw: string, current: number) {
    if (!raw.trim()) return;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return;
    const next = Math.round(v);
    if (next !== current) patch({ [key]: next });
  }

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to save (${res.status})`);
      }
      setSaveError(null);
      onChanged();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-3 px-4 py-3 md:grid-cols-[20px_140px_minmax(0,1fr)_150px_auto]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
          className="text-neutral-500 hover:text-neutral-200"
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <button type="button" onClick={onToggle} className="min-w-0 text-left">
          <p className="text-sm font-medium text-neutral-100">{platformLabel(channel.platform)}</p>
          {channel.external_handle ? (
            <p className="truncate text-xs text-neutral-500">@{channel.external_handle.replace(/^@/, "")}</p>
          ) : null}
        </button>

        <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 md:col-span-1">
          <Status tone={channelTone(channel)}>{channelStateLabel(channel)}</Status>
          {!handPosted ? (
            <span className="text-xs text-neutral-500" title={AUTOMATION_HINT[channel.automation_level]}>
              {AUTOMATION_LABEL[channel.automation_level]}
            </span>
          ) : null}
          {!handPosted ? (
            <span className="text-xs tabular-nums text-neutral-500">
              {channel.max_posts_per_day}/day · {channel.max_replies_per_day} replies
            </span>
          ) : null}
          {saving ? <Loader2 className="size-3.5 animate-spin text-neutral-500" /> : null}
        </div>

        <div className="hidden md:block" />

        <div className="col-span-2 flex justify-end md:col-span-1">
          {channel.status === "active" ? (
            <button type="button" disabled={saving} onClick={() => patch({ status: "paused" })} className={cls.ghost}>
              Pause
            </button>
          ) : channel.status === "paused" ? (
            <button type="button" disabled={saving} onClick={() => patch({ status: "active" })} className={cls.ghost}>
              Resume
            </button>
          ) : null}
        </div>
      </div>

      {saveError ? <p className={cn(cls.errorText, "px-4 pb-2")}>{saveError}</p> : null}

      {open ? (
        <div className="grid gap-6 border-t border-white/[0.06] bg-neutral-950/40 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <SectionLabel>Settings</SectionLabel>
            <label className="block">
              <span className={cn(cls.label, "mb-1 block")}>Platform handle</span>
              <Input
                value={handle}
                placeholder="@handle"
                onChange={(event) => setHandle(event.target.value)}
                onBlur={() => {
                  if ((channel.external_handle ?? "") !== handle) patch({ external_handle: handle || null });
                }}
                className={cls.input}
              />
            </label>
            {!handPosted ? (
              <>
                <label className="block">
                  <span className={cn(cls.label, "mb-1 block")}>Automation</span>
                  <Select value={channel.automation_level} onValueChange={(value) => patch({ automation_level: value })}>
                    <SelectTrigger className={cls.select}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={cls.menu}>
                      <SelectItem value="approve_first">Review first: a person approves each piece</SelectItem>
                      <SelectItem value="auto">Auto: publishes without review</SelectItem>
                      <SelectItem value="draft_only">Drafts only: the tool never publishes here</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className={cn(cls.label, "mb-1 block")}>Posts per day</span>
                    <Input
                      type="number"
                      min={0}
                      defaultValue={channel.max_posts_per_day}
                      onBlur={(event) => patchCap("max_posts_per_day", event.target.value, channel.max_posts_per_day)}
                      className={cls.input}
                    />
                  </label>
                  <label className="block">
                    <span className={cn(cls.label, "mb-1 block")}>Replies per day</span>
                    <Input
                      type="number"
                      min={0}
                      defaultValue={channel.max_replies_per_day}
                      onBlur={(event) => patchCap("max_replies_per_day", event.target.value, channel.max_replies_per_day)}
                      className={cls.input}
                    />
                  </label>
                </div>
              </>
            ) : (
              <p className="text-xs text-neutral-500">
                Posted by hand: the persona drafts, you post from your own account and mark it published in the queue. No automation level to earn.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <SectionLabel>Connection</SectionLabel>
            <ChannelConnect token={token} channel={channel} onChanged={onChanged} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect: the credential each platform takes.
// ---------------------------------------------------------------------------

type SocialAccount = { id: number; platform: string; username: string };

function ChannelConnect({ token, channel, onChanged }: { token: string; channel: Channel; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}/connect`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not connect");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}/connect`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not disconnect");
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  const common = { channel, busy, error, onDisconnect: disconnect };

  if (channel.publish_via === "post_bridge") {
    return <PostBridgeConnect token={token} {...common} onConnect={(accountId) => connect({ post_bridge_account_id: accountId })} />;
  }
  if (channel.platform === "devto") {
    return <DevtoConnect {...common} onConnect={(apiKey) => connect({ api_key: apiKey })} />;
  }
  if (channel.platform === "blog") {
    return <BlogConnect {...common} onConnect={(payload) => connect(payload)} />;
  }
  if (channel.platform === "medium") {
    return <MediumConnect token={token} {...common} onConnect={(payload) => connect(payload)} />;
  }
  if (channel.publish_via === "manual") {
    return <ManualConnect {...common} onConnect={() => connect({ enable: true })} />;
  }
  return <p className="text-xs text-neutral-500">No publishing integration for {platformLabel(channel.platform)} yet. The persona drafts here; a person posts.</p>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-neutral-500">{children}</p>;
}

function PostBridgeConnect({
  token,
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  token: string;
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: (accountId: number) => void;
  onDisconnect: () => void;
}) {
  const connectedId = channel.channel_config.post_bridge_account_id ? Number(channel.channel_config.post_bridge_account_id) : null;
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string>("");
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/influencers/channels/social-accounts?platform=${channel.platform}`, { headers: authHeaders(token) })
      .then((r) => r.json())
      .then((body) => {
        if (!active) return;
        setAccounts(body.accounts ?? []);
        setWarning(body.warning ?? null);
      })
      .catch(() => active && setWarning("Could not reach Post-Bridge."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [token, channel.platform]);

  const connectedAccount = accounts.find((a) => a.id === connectedId);

  if (connectedId) {
    return (
      <div className="space-y-2">
        <Hint>
          Posting through Post-Bridge as <span className="text-neutral-200">{connectedAccount ? `@${connectedAccount.username}` : `account #${connectedId}`}</span>.
        </Hint>
        {error ? <p className={cls.errorText}>{error}</p> : null}
        <button type="button" disabled={busy} onClick={onDisconnect} className={cls.outline}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Hint>Pick the Post-Bridge account this persona posts as. Not listed? Link the account in Post-Bridge first, then reload.</Hint>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={picked} onValueChange={setPicked} disabled={loading || busy}>
          <SelectTrigger className={cn(cls.select, "w-64")}>
            <SelectValue placeholder={loading ? "Loading accounts…" : "Choose an account"} />
          </SelectTrigger>
          <SelectContent className={cls.menu}>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                @{a.username}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button type="button" disabled={!picked || busy} onClick={() => onConnect(Number(picked))} className={cls.primary}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Connect"}
        </button>
      </div>
      {warning ? <p className="text-xs text-amber-300">{warning}</p> : null}
      {error ? <p className={cls.errorText}>{error}</p> : null}
    </div>
  );
}

function DevtoConnect({
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: (apiKey: string) => void;
  onDisconnect: () => void;
}) {
  const connected = channel.credentials_ref?.startsWith("vault") ?? false;
  const [key, setKey] = useState("");

  if (connected) {
    return (
      <div className="space-y-2">
        <Hint>A dev.to API key is linked, stored encrypted. Articles publish to that account.</Hint>
        {error ? <p className={cls.errorText}>{error}</p> : null}
        <button type="button" disabled={busy} onClick={onDisconnect} className={cls.outline}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Hint>Paste the persona&apos;s dev.to API key (Settings, Extensions, DEV API Keys). It is checked against dev.to and stored encrypted.</Hint>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="dev.to API key" className={cn(cls.input, "w-64")} />
        <button type="button" disabled={busy || !key.trim()} onClick={() => onConnect(key.trim())} className={cls.primary}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Connect"}
        </button>
      </div>
      {error ? <p className={cls.errorText}>{error}</p> : null}
    </div>
  );
}

function BlogConnect({
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: (payload: Record<string, string>) => void;
  onDisconnect: () => void;
}) {
  const cfg = (channel.channel_config ?? {}) as Record<string, unknown>;
  const [apiUrl, setApiUrl] = useState(typeof cfg.blog_api_url === "string" ? cfg.blog_api_url : "");
  const [sourceBase, setSourceBase] = useState(typeof cfg.blog_source_base === "string" ? cfg.blog_source_base : "");
  const [key, setKey] = useState("");
  const connected = channel.credentials_ref?.startsWith("env:") || channel.credentials_ref?.startsWith("vault:") || channel.status === "active";

  const site = (() => {
    const raw = typeof cfg.blog_api_url === "string" ? cfg.blog_api_url : "";
    try {
      return raw ? new URL(raw).hostname : "aicodereview.io";
    } catch {
      return raw || "aicodereview.io";
    }
  })();

  if (connected) {
    return (
      <div className="space-y-2">
        <Hint>
          Publishing to <span className="text-neutral-200">{site}</span> through its content API
          {channel.credentials_ref?.startsWith("vault:") ? ", with a key stored for this site." : ", with the workspace key."}
        </Hint>
        {!cfg.blog_source_base ? (
          <p className="text-xs text-amber-300">No source base set: the persona can publish here but cannot revise a page. Reconnect with the raw URL of the site&apos;s content folder.</p>
        ) : null}
        {error ? <p className={cls.errorText}>{error}</p> : null}
        <button type="button" disabled={busy} onClick={onDisconnect} className={cls.outline}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Hint>A site in the farm: where its content API lives, where its markdown reads back for revisions, and its own key. Leave the key empty for the workspace key, which only publishes to the default site.</Hint>
      <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://aicodereview.io" className={cls.input} />
      <Input
        value={sourceBase}
        onChange={(e) => setSourceBase(e.target.value)}
        placeholder="https://raw.githubusercontent.com/org/repo/main/src/content/blog"
        className={cls.input}
      />
      <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Content API key for this site (optional)" className={cls.input} />
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          onConnect({
            ...(apiUrl.trim() ? { api_url: apiUrl.trim() } : {}),
            ...(sourceBase.trim() ? { source_base: sourceBase.trim() } : {}),
            ...(key.trim() ? { key: key.trim() } : {}),
          })
        }
        className={cls.primary}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Connect"}
      </button>
      {error ? <p className={cls.errorText}>{error}</p> : null}
    </div>
  );
}

function ManualConnect({
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const what =
    channel.platform === "reddit"
      ? "a reply in a live thread, with the thread URL"
      : channel.platform === "hackernoon"
        ? "a full article for a person to submit to Hacker Noon's editors"
        : "a piece ready to paste";

  if (channel.status === "active") {
    return (
      <div className="space-y-2">
        <Hint>Drafting is on. The persona writes {what}; you post it from your own account and mark it published in the queue.</Hint>
        {error ? <p className={cls.errorText}>{error}</p> : null}
        <button type="button" disabled={busy} onClick={onDisconnect} className={cls.outline}>
          Stop drafting
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Hint>{platformLabel(channel.platform)} has no publishing API worth using. Turn drafting on and the persona writes {what}; you post it and mark it published.</Hint>
      {error ? <p className={cls.errorText}>{error}</p> : null}
      <button type="button" disabled={busy} onClick={onConnect} className={cls.primary}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Start drafting"}
      </button>
    </div>
  );
}

function MediumConnect({
  token,
  channel,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  token: string;
  channel: Channel;
  busy: boolean;
  error: string | null;
  onConnect: (payload: Record<string, unknown>) => void;
  onDisconnect: () => void;
}) {
  const cfg = (channel.channel_config ?? {}) as Record<string, unknown>;
  const connected = typeof cfg.browserbase_context_id === "string" && cfg.browserbase_context_id.length > 0;
  const [login, setLogin] = useState<{ live_url: string; context_id: string; expires_at: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pendingContext = typeof cfg.pending_context_id === "string" ? cfg.pending_context_id : null;

  async function startLogin() {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}/connect`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ start_login: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not open the login browser");
      setLogin(body.login);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Could not open the login browser");
    } finally {
      setStarting(false);
    }
  }

  if (connected) {
    return (
      <div className="space-y-2">
        <Hint>
          Signed in to Medium in a remote browser. Each approved crosspost is imported through Medium&apos;s own Import a story from the page it links, so the original keeps the canonical. Medium shows AI writing to followers only unless the page opens with a disclosure line; the import refuses a page without one.
        </Hint>
        {error ? <p className={cls.errorText}>{error}</p> : null}
        <button type="button" disabled={busy} onClick={onDisconnect} className={cls.outline}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Hint>
        Medium has no API for new integrations. Connect by signing in once inside a live remote browser; that login is what the persona publishes with. Open the login, sign in as the persona&apos;s Medium account in the tab that opens, come back and confirm.
      </Hint>
      {!login && !pendingContext ? (
        <button type="button" disabled={starting || busy} onClick={startLogin} className={cls.primary}>
          {starting ? <Loader2 className="size-3.5 animate-spin" /> : "Open Medium login"}
        </button>
      ) : null}
      {login ? (
        <div className="space-y-1">
          <a href={login.live_url} target="_blank" rel="noreferrer" className={cn(cls.link, "text-xs")}>
            Open the live browser and sign in to Medium
          </a>
          <p className="text-xs text-neutral-500">
            The browser closes on its own at {new Date(login.expires_at).toLocaleTimeString()}. Confirm once you see your Medium home.
          </p>
        </div>
      ) : null}
      {login || pendingContext ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => onConnect({ browserbase_context_id: login?.context_id ?? pendingContext })} className={cls.primary}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "I am signed in, connect"}
          </button>
          <button type="button" disabled={starting || busy} onClick={startLogin} className={cls.ghost}>
            Open the login again
          </button>
        </div>
      ) : null}
      {startError ? <p className={cls.errorText}>{startError}</p> : null}
      {error ? <p className={cls.errorText}>{error}</p> : null}
    </div>
  );
}
