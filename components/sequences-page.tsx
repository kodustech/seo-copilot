"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Linkedin,
  Loader2,
  Mail,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  SkipForward,
  Trash2,
  Users,
  Workflow,
  X,
} from "lucide-react";

import { AutoEnrollDialog } from "@/components/auto-enroll-dialog";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { findUnresolvedTokens, renderTemplate } from "@/lib/outreach/renderer";
import {
  CONTACT_TEMPLATE_VARS,
  PRODUCT_TEMPLATE_VARS,
  RESEARCH_TEMPLATE_VARS,
} from "@/lib/outreach/template-vars";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── Types ──────────────────────────────────────────────────────────

type Sequence = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  tags?: string[];
  stepCount?: number;
  enrollmentCount?: number;
};

type StepDraft = {
  key: string;
  channel: "email" | "linkedin";
  mode: "auto" | "semi";
  delayHours: number;
  linkedinAction: "connect_note" | "message" | null;
  /** email only: new conversation vs reply in previous thread */
  emailThreadMode: "new" | "reply";
  subjectTemplate: string;
  bodyTemplate: string;
};

type QueueTask = {
  id: string;
  channel: string;
  mode: string;
  status: string;
  renderedBody: string | null;
  renderedSubject: string | null;
  scheduledFor?: string;
  meta: Record<string, unknown>;
  sequenceName?: string | null;
  enrollment?: {
    companyName: string;
    domain: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactLinkedin: string | null;
    contactRole: string | null;
  };
  step?: { linkedinAction: string | null; position: number };
};

type DayMailboxStatus = {
  id: string;
  label: string;
  fromEmail: string;
  dailyCap: number;
  sentToday: number;
  lastSentAt: string | null;
  enabled: boolean;
  emailAutoSend: boolean;
};

type DaySequenceStatus = {
  id: string;
  name: string;
  emailSentToday: number;
  emailWaitingCap: number;
  readyLinkedin: number;
  readyEmail: number;
};

type ActivityStats = {
  readyLinkedin: number;
  readyEmail: number;
  readyTotal: number;
  sentToday: number;
  skippedToday: number;
  emailAutoSend: boolean;
  mailboxes?: DayMailboxStatus[];
  sequences?: DaySequenceStatus[];
};

type ResearchTable = { id: string; name: string; slug?: string | null };
type Mailbox = {
  id: string;
  label: string;
  fromEmail: string;
  connected: boolean;
  enabled: boolean;
};

function formatLastSent(iso: string | null | undefined): string {
  if (!iso) return "no sends yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A mailbox is worth looking at well before it is actually full: at 80 % of
 *  the cap there is still time to move sends to another inbox or raise the
 *  limit, and at 100 % the decision has already been made for you. The old
 *  strip only coloured a full mailbox, so 67/70 — one morning away from
 *  blocking every active sequence — rendered in the same grey as 0/40. */
const CAP_WARN_RATIO = 0.8;

/**
 * What today is, in one line.
 *
 * Replaces three equally-weighted cards (inboxes · auto email · human queue).
 * Two problems with that shape: a background process had the same visual claim
 * as the list you came to work, and the largest type on the page was spent
 * rendering "0 · 0 · 0" — the most prominent thing on screen was the absence of
 * work, which is the one thing needing no attention at all.
 *
 * The rule here: a number is emphasised only when it asks for a decision.
 * Everything else is a sentence, and anything with nothing to say is absent
 * rather than shown as a zero.
 */
function QueueStatus({
  stats,
  taskCount,
  failed,
}: {
  stats: ActivityStats | null;
  taskCount: number;
  failed: boolean;
}) {
  // Before the first fetch resolves there is no queue, no mailbox list and no
  // send count — and every empty branch below reads as a finding: "Nothing due
  // right now", "Nothing sent today", "No enabled mailboxes — nothing can
  // send." On a slow network the page opens by telling an operator their
  // outreach is dead. Say what is true instead, which is that we do not know
  // yet.
  //
  // "Not fetched yet" and "the fetch failed" look identical from here — the
  // queue route answers every internal error with a 401 and load() keeps stats
  // null either way — so the failure is passed in from the response that saw
  // it. Not derived from the shared `loading` flag: several handlers call
  // load(), and a stale one clearing the flag while a newer fetch is still in
  // the air would announce a failure that has not happened.
  if (!stats && taskCount === 0) {
    return (
      <section className="rounded-xl border border-border bg-card px-4 py-3.5">
        <span className="text-sm text-muted-foreground">
          {failed
            ? "Couldn’t load today’s queue — refresh to try again."
            : "Checking today’s queue…"}
        </span>
      </section>
    );
  }

  const ready = stats?.readyTotal ?? taskCount;
  const mailboxes = stats?.mailboxes ?? [];
  const sequences = stats?.sequences ?? [];

  const waitingCap = sequences.reduce((n, s) => n + s.emailWaitingCap, 0);
  const autoSentToday = sequences.reduce((n, s) => n + s.emailSentToday, 0);
  const tightMailboxes = mailboxes.filter(
    (mb) => mb.dailyCap > 0 && mb.sentToday / mb.dailyCap >= CAP_WARN_RATIO,
  );

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-4 py-3.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {ready > 0 ? (
            <>
              <span className="text-2xl font-semibold tabular-nums leading-none">
                {ready}
              </span>
              <span className="text-sm text-muted-foreground">
                ready for you
                {stats && (stats.readyLinkedin > 0 || stats.readyEmail > 0) ? (
                  <>
                    {" — "}
                    {[
                      stats.readyLinkedin > 0
                        ? `${stats.readyLinkedin} LinkedIn`
                        : null,
                      stats.readyEmail > 0 ? `${stats.readyEmail} email` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </>
                ) : null}
              </span>
            </>
          ) : (
            // No count, no tile, no checkmark: an empty queue is a sentence.
            <span className="text-sm font-medium">Nothing due right now</span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {autoSentToday > 0 || (stats?.sentToday ?? 0) > 0 ? (
            <>
              <span className="font-medium text-foreground tabular-nums">
                {stats?.sentToday ?? 0}
              </span>{" "}
              sent today
              {(stats?.skippedToday ?? 0) > 0
                ? ` · ${stats?.skippedToday} skipped`
                : ""}
            </>
          ) : (
            "Nothing sent today"
          )}
        </p>
      </div>

      {/* Capacity. One row per mailbox, and the bar is the point — a number
          out of a number takes a beat to read, a bar near its end does not. */}
      {mailboxes.length > 0 ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border px-4 py-2.5">
          {mailboxes.map((mb) => {
            const pct =
              mb.dailyCap > 0
                ? Math.min(100, (mb.sentToday / mb.dailyCap) * 100)
                : 0;
            const tight = mb.dailyCap > 0 && pct >= CAP_WARN_RATIO * 100;
            const full = mb.dailyCap > 0 && mb.sentToday >= mb.dailyCap;
            return (
              <div
                key={mb.id}
                className="min-w-0 flex-1 basis-48"
                title={`${mb.label}${mb.emailAutoSend ? "" : " · auto-send off"} · last ${formatLastSent(mb.lastSentAt)}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {mb.fromEmail}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs tabular-nums",
                      tight
                        ? "font-medium text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {mb.sentToday}/{mb.dailyCap}
                    {full ? " · full" : ""}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width]",
                      tight ? "bg-amber-500" : "bg-foreground/40",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : stats ? (
        // Only claimable once stats arrived: an empty mailbox list is also what
        // "not fetched yet" looks like, and the two must not read the same.
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          No enabled mailboxes — nothing can send.
        </p>
      ) : null}

      {/* Only rendered when something is actually held up. A row that always
          shows, reading "0 waiting cap", trains you to stop reading it. */}
      {waitingCap > 0 || tightMailboxes.length > 0 ? (
        <p className="border-t border-border bg-amber-500/[0.06] px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          {[
            waitingCap > 0
              ? `${waitingCap} email${waitingCap === 1 ? "" : "s"} held by the daily cap — they retry tomorrow, or now if you raise the limit`
              : null,
            tightMailboxes.length > 0 && waitingCap === 0
              ? `${tightMailboxes.map((mb) => mb.fromEmail).join(", ")} near the daily cap`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

type EnrollmentRow = {
  id: string;
  companyName: string;
  domain: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLinkedin: string | null;
  contactRole: string | null;
  status: string;
  currentStepPosition: number;
  nextRunAt: string | null;
  lastError: string | null;
  source: string;
  createdAt: string;
  /** Frozen product-signal values behind the product tokens. The API has
   *  always sent these; the type omitted them, so the preview could not
   *  reach them. */
  templateVars: Record<string, string> | null;
};

type SequenceStepProgress = {
  position: number;
  channel: string;
  mode: string;
  status: string;
  error: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  subject?: string | null;
  bodySnippet?: string | null;
  linkedinAction?: string | null;
};

type SequenceLeadProgress = {
  enrollment: EnrollmentRow;
  steps: SequenceStepProgress[];
  completedSteps: number;
  totalSteps: number;
  progressPct: number;
  lastTaskError: string | null;
};

type SequenceHealth = {
  sequenceId: string;
  totalSteps: number;
  enrollments: { total: number; byStatus: Record<string, number> };
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    email: Record<string, number>;
    linkedin: Record<string, number>;
  };
  rates: {
    bounceRate: number;
    emailFailRate: number;
    skipRate: number;
    completionRate: number;
  };
  recentErrors: Array<{
    contactName: string | null;
    companyName: string;
    channel: string;
    error: string;
    at: string;
    enrollmentStatus: string;
  }>;
  leads: SequenceLeadProgress[];
  steps: Array<{ position: number; channel: string; mode: string }>;
};

function stepStatusDot(status: string): string {
  switch (status) {
    case "sent":
      return "bg-emerald-500";
    case "failed":
      return "bg-rose-500";
    case "skipped":
      return "bg-amber-500";
    case "ready":
    case "sending":
      return "bg-sky-500";
    case "scheduled":
    case "pending":
      return "bg-muted-foreground/40";
    case "cancelled":
      return "bg-muted-foreground/30";
    default:
      return "bg-border";
  }
}

function stepStatusLabel(status: string): string {
  switch (status) {
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "ready":
      return "Ready for you";
    case "sending":
      return "Sending…";
    case "scheduled":
      return "Scheduled";
    case "cancelled":
      return "Cancelled";
    case "pending":
      return "Waiting";
    case "none":
      return "Not started";
    default:
      return status;
  }
}

function formatTaskWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function stepChannelLabel(s: {
  channel: string;
  linkedinAction?: string | null;
}): string {
  if (s.channel === "email") return "Email";
  if (s.linkedinAction === "connect_note") return "LinkedIn connect";
  if (s.linkedinAction === "message") return "LinkedIn message";
  return "LinkedIn";
}

function enrollmentStatusBadge(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case "completed":
      return "bg-muted text-muted-foreground";
    case "bounced":
    case "failed":
      return "bg-rose-500/15 text-rose-700 dark:text-rose-400";
    case "paused":
    case "cancelled":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "replied":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

// ── Helpers ────────────────────────────────────────────────────────

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

function newKey() {
  return `s_${Math.random().toString(36).slice(2, 10)}`;
}

function formatWait(hours: number): string {
  if (hours <= 0) return "Immediately";
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return d === 1 ? "1 day" : `${d} days`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

function blankStep(channel: "email" | "linkedin"): StepDraft {
  if (channel === "email") {
    return {
      key: newKey(),
      channel: "email",
      mode: "auto",
      delayHours: 24,
      linkedinAction: null,
      emailThreadMode: "new",
      subjectTemplate: "Quick note for {{company}}",
      bodyTemplate: `Hi {{first_name}},

Noticed {{company}} is investing in quality. Worth a quick chat?

— Kodus`,
    };
  }
  return {
    key: newKey(),
    channel: "linkedin",
    mode: "semi",
    delayHours: 0,
    linkedinAction: "connect_note",
    emailThreadMode: "new",
    subjectTemplate: "",
    bodyTemplate:
      "Hey {{first_name}} — saw {{company}} is hiring for QA. Open to a quick chat?",
  };
}

function mapApiStep(s: Record<string, unknown>): StepDraft {
  const channel = s.channel === "email" ? "email" : "linkedin";
  const action = String(
    s.linkedinAction ?? s.linkedin_action ?? "message",
  ) as "connect_note" | "message";
  const threadRaw = String(
    s.emailThreadMode ?? s.email_thread_mode ?? "reply",
  );
  return {
    key: newKey(),
    channel,
    mode:
      channel === "linkedin"
        ? "semi"
        : s.mode === "semi"
          ? "semi"
          : "auto",
    delayHours: Number(s.delayHours ?? s.delay_hours ?? 0),
    linkedinAction: channel === "linkedin" ? action : null,
    emailThreadMode: channel === "email" && threadRaw === "new" ? "new" : "reply",
    subjectTemplate: String(s.subjectTemplate ?? s.subject_template ?? ""),
    bodyTemplate: String(s.bodyTemplate ?? s.body_template ?? ""),
  };
}

/** The first email has no prior outbound message, so it must start a thread. */
function normalizeFirstEmailThreadMode(steps: StepDraft[]): StepDraft[] {
  let hasPreviousEmail = false;
  return steps.map((step) => {
    if (step.channel !== "email") return step;
    if (hasPreviousEmail) return step;
    hasPreviousEmail = true;
    if (step.emailThreadMode === "new") return step;
    return {
      ...step,
      emailThreadMode: "new",
      subjectTemplate: step.subjectTemplate.replace(/^(re:\s*)+/i, ""),
    };
  });
}

function stepTitle(s: StepDraft): string {
  if (s.channel === "linkedin") {
    return s.linkedinAction === "connect_note"
      ? "Connection request"
      : "LinkedIn message";
  }
  const mode = s.mode === "auto" ? "Auto email" : "Manual email";
  return s.emailThreadMode === "reply" ? `${mode} · reply` : `${mode} · new`;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-emerald-500"
      : status === "paused"
        ? "bg-amber-500"
        : status === "archived"
          ? "bg-neutral-500"
          : "bg-sky-500";
  return <span className={cn("inline-block size-1.5 rounded-full", color)} />;
}

/**
 * The tokens a step template may use, in the editor next to the body.
 *
 * Without it the only discoverable tokens were the two in the placeholder hint,
 * so copy that needed a signup date got a hand-typed "[DATE]" that no renderer
 * ever filled.
 */
function TokenCatalog() {
  const groups: Array<{ label: string; vars: typeof CONTACT_TEMPLATE_VARS }> = [
    { label: "Always available", vars: CONTACT_TEMPLATE_VARS },
    {
      label: "Research list variables — only when the enrolled row has the value",
      vars: RESEARCH_TEMPLATE_VARS,
    },
    {
      label: "Product signals — CRM accounts with a connected org only",
      vars: PRODUCT_TEMPLATE_VARS,
    },
  ];
  return (
    <details className="rounded-lg border border-dashed border-border px-2.5 py-1.5">
      <summary className="cursor-pointer text-[10px] text-muted-foreground marker:text-muted-foreground">
        Variables you can use — a token with no value blocks the send
      </summary>
      <div className="mt-2 space-y-3">
        {groups.map((g) => (
          <div key={g.label} className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">
              {g.label}
            </p>
            <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {g.vars.map((v) => (
                <li key={v.token} className="text-[10px] leading-relaxed">
                  <code className="text-foreground">{`{{${v.token}}}`}</code>{" "}
                  <span className="text-muted-foreground">{v.description}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

// ── Segmented control ──────────────────────────────────────────────

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Tags ───────────────────────────────────────────────────────────

/** Client-side mirror of the server's tag rules, so the chip you see is the
 *  chip that gets stored. The server still re-normalizes as the authority. */
function cleanTag(s: string): string {
  return s.trim().replace(/\s+/g, " ").slice(0, 32);
}

const MAX_TAGS = 20;

/**
 * Free-form tag input: chips you can remove, plus a combobox that both offers
 * tags already used on other campaigns and lets you create a new one on the
 * spot. No management screen — a tag exists because a campaign wears it.
 */
function TagEditor({
  value,
  suggestions,
  onChange,
}: {
  value: string[];
  suggestions: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const has = (t: string) =>
    value.some((v) => v.toLowerCase() === t.toLowerCase());

  const add = (raw: string) => {
    const t = cleanTag(raw);
    setInput("");
    if (!t || has(t) || value.length >= MAX_TAGS) return;
    onChange([...value, t]);
  };
  const remove = (t: string) => onChange(value.filter((v) => v !== t));

  const matches = useMemo(() => {
    const q = input.trim().toLowerCase();
    return suggestions
      .filter((s) => !has(s))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, input, value]);

  const canCreate = input.trim().length > 0 && !has(cleanTag(input));
  const atCap = value.length >= MAX_TAGS;

  return (
    <div className="relative w-full">
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5",
          "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground"
          >
            {t}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                remove(t);
              }}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`Remove tag ${t}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={input}
          disabled={atCap}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(input);
            } else if (e.key === "Backspace" && !input && value.length > 0) {
              remove(value[value.length - 1]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={
            atCap
              ? `Max ${MAX_TAGS} tags`
              : value.length === 0
                ? "Add tags…"
                : ""
          }
          className="min-w-24 flex-1 bg-transparent px-0.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          aria-label="Add a tag"
        />
      </div>

      {open && !atCap && (canCreate || matches.length > 0) && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-60 w-full min-w-56 overflow-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-md">
          {canCreate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(input)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
            >
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                Create{" "}
                <span className="font-medium text-foreground">
                  {cleanTag(input)}
                </span>
              </span>
            </button>
          )}
          {matches.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(s)}
              className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sequences list: filters + row ──────────────────────────────────

type SeqStatusFilter = "all" | "active" | "draft" | "paused" | "archived";

/** Filter order is the working order: what is running, what could be turned
 *  on, what was stopped, what is out of the way. Not alphabetical. */
const SEQ_STATUS_ORDER: Exclude<SeqStatusFilter, "all">[] = [
  "active",
  "draft",
  "paused",
  "archived",
];
const SEQ_STATUS_LABEL: Record<Exclude<SeqStatusFilter, "all">, string> = {
  active: "Running",
  draft: "Draft",
  paused: "Paused",
  archived: "Archived",
};

/**
 * One sequence, one row.
 *
 * A divided list, not a stack of cards. Nineteen bordered boxes all read as
 * nineteen equal things, and the one that is actually running gets lost among
 * them; the old row also leaned on a 2px side-stripe to mark it, which is
 * invisible and, at that width, just noise. Here the rows share a container
 * and a hairline divider, the leading dot carries status, and only the running
 * cadences get a full-contrast name. Everything a draft has to say recedes.
 *
 * The three numbers live in fixed columns so the eye reads straight down them.
 * Only "due" is allowed to raise its voice, because it is the one that asks you
 * to do something today; the rest stay quiet until there is something to know.
 */
function SequenceRow({
  sequence,
  today,
  onOpen,
}: {
  sequence: Sequence;
  today?: DaySequenceStatus;
  onOpen: () => void;
}) {
  const running = sequence.status === "active";
  const due = (today?.readyLinkedin ?? 0) + (today?.readyEmail ?? 0);
  const sent = today?.emailSentToday ?? 0;
  const enrolled = sequence.enrollmentCount ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
        "hover:bg-muted/40",
        "focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      <span className="shrink-0 self-center">
        <StatusDot status={sequence.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate text-sm",
              running
                ? "font-medium text-foreground"
                : "text-foreground/70 group-hover:text-foreground",
            )}
          >
            {sequence.name}
          </span>
          {!running && (
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
              {sequence.status}
            </span>
          )}
          {(sequence.tags ?? []).length > 0 && (
            <span className="hidden shrink-0 items-center gap-1 sm:flex">
              {(sequence.tags ?? []).slice(0, 2).map((t) => (
                <span
                  key={t}
                  className="max-w-28 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {t}
                </span>
              ))}
              {(sequence.tags ?? []).length > 2 && (
                <span className="text-[10px] text-muted-foreground/50">
                  +{(sequence.tags ?? []).length - 2}
                </span>
              )}
            </span>
          )}
        </span>
        {sequence.description ? (
          <span className="truncate text-xs text-muted-foreground/60">
            {sequence.description}
          </span>
        ) : null}
      </span>

      {/* Fixed columns so the eye reads straight down them, and importance
          escalates rightward toward the chevron: structure, then reach, then
          the one thing due today. */}
      <span className="hidden shrink-0 items-center gap-5 sm:flex">
        <span
          className="w-16 text-right text-xs tabular-nums text-muted-foreground/60"
          title={`${sequence.stepCount ?? 0} steps in this cadence`}
        >
          {sequence.stepCount ?? 0} steps
        </span>
        <span
          className={cn(
            "w-20 text-right text-xs tabular-nums",
            enrolled > 0 ? "text-foreground/80" : "text-muted-foreground/40",
          )}
          title={`${enrolled} people currently enrolled`}
        >
          {enrolled} active
        </span>
        <span className="flex w-20 justify-end">
          {due > 0 ? (
            <span
              className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-700 dark:text-amber-400"
              title="Steps waiting in today's queue"
            >
              {due} due
            </span>
          ) : sent > 0 ? (
            <span
              className="text-xs tabular-nums text-muted-foreground"
              title="Emails auto-sent today"
            >
              {sent} sent
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/30">—</span>
          )}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/70" />
    </button>
  );
}

// ── Page ───────────────────────────────────────────────────────────

export function SequencesPage() {
  const token = useAuthToken();
  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const [view, setView] = useState<"list" | "queue" | "editor">("queue");
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [queueFailed, setQueueFailed] = useState(false);
  /** Monotonic load counter — see load(). Only the newest generation writes. */
  const loadIdRef = useRef(0);
  const [activityFilter, setActivityFilter] = useState<
    "all" | "linkedin" | "email"
  >("all");
  // Sequences tab: eleven cadences of identical visual weight, one of them
  // running. Search and a status filter are what make that list workable —
  // without them the only way to find the live one is to read every card.
  const [seqQuery, setSeqQuery] = useState("");
  const [seqStatus, setSeqStatus] = useState<SeqStatusFilter>("all");
  const [seqTags, setSeqTags] = useState<string[]>([]);
  const [tables, setTables] = useState<ResearchTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * Per-task copy edits made in the queue, keyed by task id. A task with an
   * entry here is being edited; absent means "send what the server rendered".
   *
   * Deliberately client-only: the edit is for the send you are about to make,
   * not a saved draft, so it does not survive a reload and never becomes what
   * the cron picks up.
   */
  const [drafts, setDrafts] = useState<
    Record<string, { subject: string; body: string }>
  >({});
  const [mailboxConfigured, setMailboxConfigured] = useState(true);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState("draft");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editMailboxId, setEditMailboxId] = useState("default");
  const [editSteps, setEditSteps] = useState<StepDraft[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enrollmentCount, setEnrollmentCount] = useState(0);
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
  const [sequenceHealth, setSequenceHealth] = useState<SequenceHealth | null>(
    null,
  );
  const [editorTab, setEditorTab] = useState<"dashboard" | "steps" | "people">(
    "dashboard",
  );
  const [peopleFilter, setPeopleFilter] = useState<
    "all" | "active" | "completed" | "bounced" | "other"
  >("all");
  /** Expanded person timeline on People tab */
  const [timelinePersonId, setTimelinePersonId] = useState<string | null>(null);
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(null);
  const [previewPersonId, setPreviewPersonId] = useState<string | "sample">(
    "sample",
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [enrollTableId, setEnrollTableId] = useState("");
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    // Only the newest load writes state. Refresh fires load() without awaiting
    // it and a dozen mutation handlers call it too, so two can be in the air at
    // once — and then a stale one landing last would undo the newer result,
    // most visibly by flipping the queue back to failed after it had loaded.
    const generation = ++loadIdRef.current;
    const current = () => loadIdRef.current === generation;

    setLoading(true);
    // A retry is not a failure until it fails. Left set, the previous failure
    // would keep claiming the queue could not be loaded for the whole of the
    // next in-flight fetch.
    setQueueFailed(false);
    try {
      // allSettled, not all: fail-fast would throw away three good responses
      // because the fourth rejected, and worse, it would attribute someone
      // else's network error to the queue. Each endpoint answers for itself.
      const [seqRes, queueRes, tablesRes, mailboxRes] = await Promise.allSettled([
        fetch("/api/outreach/sequences", { headers: headers() }),
        fetch("/api/outreach/sequences/queue", {
          headers: headers(),
        }),
        fetch("/api/research/tables", { headers: headers() }),
        fetch("/api/outreach/mailbox", { headers: headers() }),
      ]);
      if (!current()) return;

      if (seqRes.status === "fulfilled" && seqRes.value.ok) {
        const d = await seqRes.value.json();
        if (!current()) return;
        setSequences(d.sequences ?? []);
        setMailboxConfigured(Boolean(d.mailboxConfigured));
      }

      // Record the queue failure instead of inferring it from an empty queue:
      // the route answers every internal error with a 401, so this response is
      // the only place the difference between "no work" and "we never found
      // out" exists. A rejected fetch — refused connection, DNS — counts the
      // same, and is why this is not just an `!ok` check.
      if (queueRes.status === "fulfilled" && queueRes.value.ok) {
        try {
          const d = await queueRes.value.json();
          if (!current()) return;
          setTasks(d.tasks ?? []);
          setStats(d.stats ?? null);
        } catch {
          if (current()) setQueueFailed(true);
        }
      } else if (current()) {
        setQueueFailed(true);
      }

      if (tablesRes.status === "fulfilled" && tablesRes.value.ok) {
        const d = await tablesRes.value.json();
        if (!current()) return;
        setTables(d.tables ?? []);
      }
      if (mailboxRes.status === "fulfilled" && mailboxRes.value.ok) {
        const d = await mailboxRes.value.json();
        if (!current()) return;
        setMailboxes((d.mailboxes ?? []) as Mailbox[]);
      }
    } catch {
      // A body that fails to parse on one of the other three routes is not the
      // queue's failure to report — swallow it here rather than let it escape
      // as an unhandled rejection or mislabel the queue.
    } finally {
      if (current()) setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = async (id: string) => {
    if (!token) return;
    setEditingId(id);
    setView("editor");
    setEditLoading(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${id}`, {
        headers: headers(),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load");
        setView("list");
        setEditingId(null);
        return;
      }
      setEditName(data.sequence?.name ?? "");
      setEditDescription(data.sequence?.description ?? "");
      setEditStatus(data.sequence?.status ?? "draft");
      setEditTags(
        Array.isArray(data.sequence?.tags)
          ? (data.sequence.tags as string[])
          : [],
      );
      setEditMailboxId(data.sequence?.mailboxId ?? data.sequence?.mailbox_id ?? "default");
      setSequenceHealth((data.health as SequenceHealth) ?? null);
      const enrRaw = (data.enrollments ?? []) as Record<string, unknown>[];
      const enrMapped: EnrollmentRow[] = enrRaw.map((e) => ({
        id: String(e.id),
        companyName: String(e.companyName ?? e.company_name ?? ""),
        domain: (e.domain as string | null) ?? null,
        contactName: (e.contactName ?? e.contact_name ?? null) as string | null,
        contactEmail: (e.contactEmail ?? e.contact_email ?? null) as
          | string
          | null,
        contactLinkedin: (e.contactLinkedin ??
          e.contact_linkedin ??
          null) as string | null,
        contactRole: (e.contactRole ?? e.contact_role ?? null) as string | null,
        status: String(e.status ?? "active"),
        currentStepPosition: Number(
          e.currentStepPosition ?? e.current_step_position ?? 0,
        ),
        nextRunAt: (e.nextRunAt ?? e.next_run_at ?? null) as string | null,
        lastError: (e.lastError ?? e.last_error ?? null) as string | null,
        source: String(e.source ?? "research"),
        createdAt: String(e.createdAt ?? e.created_at ?? ""),
        // Dropping this here is invisible: the field is optional, so the
        // preview compiles and silently renders every product token raw.
        templateVars: (e.templateVars ?? e.template_vars ?? null) as Record<
          string,
          string
        > | null,
      }));
      setEnrollments(enrMapped);
      setEnrollmentCount(enrMapped.length);
      // Prefer health dashboard when anyone is enrolled
      setEditorTab(enrMapped.length > 0 ? "dashboard" : "steps");
      // Prefer a real person for sequence preview
      const firstActive =
        enrMapped.find((e) => e.status === "active") ?? enrMapped[0];
      setPreviewPersonId(firstActive?.id ?? "sample");
      const steps = ((data.steps ?? []) as Record<string, unknown>[]).map(
        mapApiStep,
      );
      const next = normalizeFirstEmailThreadMode(
        steps.length ? steps : [blankStep("linkedin")],
      );
      setEditSteps(next);
      setSelectedStepKey(next[0]?.key ?? null);
    } finally {
      setEditLoading(false);
    }
  };

  const reloadEnrollments = async (sequenceId: string) => {
    if (!token) return;
    const res = await fetch(`/api/outreach/sequences/${sequenceId}`, {
      headers: headers(),
    });
    if (!res.ok) return;
    const data = await res.json();
    const enrRaw = (data.enrollments ?? []) as Record<string, unknown>[];
    const enrMapped: EnrollmentRow[] = enrRaw.map((e) => ({
      id: String(e.id),
      companyName: String(e.companyName ?? e.company_name ?? ""),
      domain: (e.domain as string | null) ?? null,
      contactName: (e.contactName ?? e.contact_name ?? null) as string | null,
      contactEmail: (e.contactEmail ?? e.contact_email ?? null) as
        | string
        | null,
      contactLinkedin: (e.contactLinkedin ?? e.contact_linkedin ?? null) as
        | string
        | null,
      contactRole: (e.contactRole ?? e.contact_role ?? null) as string | null,
      status: String(e.status ?? "active"),
      currentStepPosition: Number(
        e.currentStepPosition ?? e.current_step_position ?? 0,
      ),
      nextRunAt: (e.nextRunAt ?? e.next_run_at ?? null) as string | null,
      lastError: (e.lastError ?? e.last_error ?? null) as string | null,
      source: String(e.source ?? "research"),
      createdAt: String(e.createdAt ?? e.created_at ?? ""),
      templateVars: (e.templateVars ?? e.template_vars ?? null) as Record<
        string,
        string
      > | null,
    }));
    setEnrollments(enrMapped);
    setEnrollmentCount(enrMapped.length);
    setSequenceHealth((data.health as SequenceHealth) ?? null);
  };

  const removeEnrollment = async (enrollment: EnrollmentRow) => {
    if (!token || !editingId) return;
    if (
      !confirm(
        `Remove ${enrollment.contactName || "this person"} from this campaign? Pending tasks will be cancelled; sent history stays visible.`,
      )
    ) {
      return;
    }
    setBusyId(enrollment.id);
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}/enroll`, {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({ enrollment_ids: [enrollment.id] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not remove person from campaign");
        return;
      }
      setNotice(`Removed ${enrollment.contactName || "person"} from the campaign.`);
      await Promise.all([reloadEnrollments(editingId), load()]);
    } finally {
      setBusyId(null);
    }
  };

  const pauseEnrollment = async (
    enrollment: EnrollmentRow,
    paused: boolean,
  ) => {
    if (!token || !editingId) return;
    setBusyId(enrollment.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/outreach/sequences/${editingId}/enrollments/${enrollment.id}`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({
            status: paused ? "paused" : "active",
            reason: paused ? "Paused by user" : undefined,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not update person");
        return;
      }
      const name = enrollment.contactName || "Person";
      setNotice(
        paused
          ? `Paused ${name} — pending steps cancelled until resume`
          : `Resumed ${name} — back on the cadence`,
      );
      await Promise.all([reloadEnrollments(editingId), load()]);
    } finally {
      setBusyId(null);
    }
  };

  /** Convert handoff: sequence person → CRM Accounts (by domain). */
  const promoteEnrollmentToCrm = async (enrollment: EnrollmentRow) => {
    if (!token || !editingId) return;
    setBusyId(enrollment.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/outreach/sequences/${editingId}/enrollments/${enrollment.id}`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ action: "promote_crm" }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not promote to Accounts");
        return;
      }
      const name = enrollment.companyName || enrollment.contactName || "Company";
      setNotice(
        data.created
          ? `Created ${name} in Accounts`
          : `Updated ${name} in Accounts`,
      );
    } finally {
      setBusyId(null);
    }
  };

  const createSeq = async () => {
    if (!token || !newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/outreach/sequences", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create");
        return;
      }
      setCreateOpen(false);
      setNewName("");
      await load();
      if (data.sequence?.id) await openEditor(data.sequence.id);
    } finally {
      setCreating(false);
    }
  };

  const saveSequence = async () => {
    if (!token || !editingId) return;
    if (!editName.trim()) {
      setError("Name is required");
      return;
    }
    if (editSteps.length === 0) {
      setError("Add at least one step");
      return;
    }
    for (let i = 0; i < editSteps.length; i++) {
      const s = editSteps[i];
      if (!s.bodyTemplate.trim()) {
        setError(`Step ${i + 1}: message is empty`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
          status: editStatus,
          mailboxId: editMailboxId === "default" ? null : editMailboxId,
          steps: editSteps.map((s) => ({
            channel: s.channel,
            mode: s.channel === "linkedin" ? "semi" : s.mode,
            delayHours: Number(s.delayHours) || 0,
            linkedinAction:
              s.channel === "linkedin" ? s.linkedinAction : null,
            subjectTemplate:
              s.channel === "email" ? s.subjectTemplate || null : null,
            bodyTemplate: s.bodyTemplate,
            emailThreadMode:
              s.channel === "email" ? s.emailThreadMode : null,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setNotice("Saved");
      await load();
      if (data.steps) {
        const mapped = (data.steps as Record<string, unknown>[]).map(
          mapApiStep,
        );
        setEditSteps(normalizeFirstEmailThreadMode(mapped));
        setSelectedStepKey((k) =>
          mapped.some((m) => m.key === k) ? k : mapped[0]?.key ?? null,
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteSequence = async () => {
    if (!token || !editingId) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}`, {
        method: "DELETE",
        headers: headers(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (data as { error?: string }).error ?? "Failed to delete sequence",
        );
        setDeleteOpen(false);
        return;
      }
      setDeleteOpen(false);
      setEditingId(null);
      setView("list");
      setNotice(
        `Deleted “${(data as { name?: string }).name ?? "sequence"}”` +
          ((data as { deletedEnrollments?: number }).deletedEnrollments
            ? ` · ${(data as { deletedEnrollments: number }).deletedEnrollments} people removed`
            : ""),
      );
      await load();
    } finally {
      setDeleting(false);
    }
  };

  /** Status is intentional — applies immediately (does not wait for Save). */
  const changeStatus = async (status: string) => {
    if (!token || !editingId) return;
    const prev = editStatus;
    setEditStatus(status);
    setError(null);
    setNotice(null);
    setBusyId("status");
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditStatus(prev);
        setError((data as { error?: string }).error ?? "Failed to update status");
        return;
      }
      const labels: Record<string, string> = {
        draft: "Draft — not running. Activate when ready.",
        active: "Active — queue and auto-email will run.",
        paused: "Paused — tasks held until you activate again.",
        archived: "Archived — hidden from normal use.",
      };
      setNotice(labels[status] ?? `Status → ${status}`);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Tags persist on every add/remove (like status), not on the Save button —
   * Save only shows on the Steps tab, and tags should be editable from any
   * tab. The full array is sent each time so the last write wins cleanly, and
   * the optimistic update is reconciled with the server's normalized result.
   */
  const saveTags = async (next: string[]) => {
    if (!token || !editingId) return;
    const prev = editTags;
    setEditTags(next);
    setError(null);
    try {
      const res = await fetch(`/api/outreach/sequences/${editingId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ tags: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditTags(prev);
        setError(
          (data as { error?: string }).error ??
            "Could not save tags — is the tags column migrated?",
        );
        return;
      }
      const saved = (data as { sequence?: { tags?: string[] } }).sequence?.tags;
      if (Array.isArray(saved)) setEditTags(saved);
      // Keep the list (and its filter chips / autocomplete) in sync with the
      // new tag without a full-page churn on every keystroke.
      setSequences((prevSeqs) =>
        prevSeqs.map((s) =>
          s.id === editingId
            ? { ...s, tags: Array.isArray(saved) ? saved : next }
            : s,
        ),
      );
    } catch {
      setEditTags(prev);
      setError("Could not save tags");
    }
  };

  const updateStep = (key: string, patch: Partial<StepDraft>) => {
    setEditSteps((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      const updated = prev.map((s) => {
        if (s.key !== key) return s;
        const next = { ...s, ...patch };
        if (patch.channel === "linkedin") {
          next.mode = "semi";
          next.linkedinAction = next.linkedinAction ?? "connect_note";
          next.subjectTemplate = "";
        }
        if (patch.channel === "email") {
          next.mode = next.mode === "semi" ? "semi" : "auto";
          next.linkedinAction = null;
          if (!next.emailThreadMode) next.emailThreadMode = "new";
          if (!next.subjectTemplate) {
            next.subjectTemplate = "Quick note for {{company}}";
          }
        }
        // Reply in thread → subject = Re: <previous email step subject>
        if (
          patch.emailThreadMode === "reply" &&
          next.channel === "email" &&
          idx >= 0
        ) {
          const prevEmail = [...prev]
            .slice(0, idx)
            .reverse()
            .find((x) => x.channel === "email");
          if (prevEmail?.subjectTemplate?.trim()) {
            const root = prevEmail.subjectTemplate
              .trim()
              .replace(/^(re:\s*)+/i, "");
            next.subjectTemplate = `Re: ${root}`;
          } else if (!/^re:\s/i.test(next.subjectTemplate.trim())) {
            const root = next.subjectTemplate.trim() || "Quick note for {{company}}";
            next.subjectTemplate = `Re: ${root.replace(/^(re:\s*)+/i, "")}`;
          }
        }
        return next;
      });
      return normalizeFirstEmailThreadMode(updated);
    });
  };

  const enroll = async () => {
    if (!token || !enrollSeqId || !enrollTableId) return;
    setEnrolling(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/outreach/sequences/${enrollSeqId}/enroll`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            source: "research",
            table_ref: enrollTableId,
            all_people: true,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Enroll failed");
        return;
      }
      setEnrollOpen(false);
      const seqStatus = String(data.sequenceStatus ?? editStatus ?? "draft");
      const parts = [
        `Enrolled ${data.enrolled}`,
        data.skipped ? `skipped ${data.skipped}` : null,
        data.missingLinkedin
          ? `${data.missingLinkedin} without LinkedIn`
          : null,
        data.missingEmail
          ? `${data.missingEmail} without email (email steps will be skipped)`
          : null,
        seqStatus !== "active"
          ? `sequence is ${seqStatus} — Activate to start outreach`
          : null,
      ].filter(Boolean);
      setNotice(
        `${parts.join(" · ")}. Check People for warnings.`,
      );
      if (
        (data.errors as string[] | undefined)?.length ||
        (data.warnings as string[] | undefined)?.length
      ) {
        const bits = [
          ...((data.errors as string[]) ?? []).slice(0, 5),
          ...((data.warnings as string[]) ?? []).slice(0, 5),
        ];
        setError(bits.join(" · "));
      }
      await load();
      // Stay on sequence editor → People so you see who is running
      if (enrollSeqId) {
        setEditingId(enrollSeqId);
        setView("editor");
        await openEditor(enrollSeqId);
        setEditorTab("people");
      }
    } finally {
      setEnrolling(false);
    }
  };

  const complete = async (taskId: string, outcome: "sent" | "skipped") => {
    if (!token) return;
    setBusyId(taskId);
    try {
      const res = await fetch(
        `/api/outreach/sequences/tasks/${taskId}/complete`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ outcome }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed");
        return;
      }
      setNotice(
        outcome === "sent"
          ? "Marked done — this person moves to the next step"
          : "Skipped — next step scheduled",
      );
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied");
    } catch {
      setError("Could not copy");
    }
  };

  /**
   * Send the queued email from here, through the sequence's mailbox.
   *
   * "Open Gmail" stays for the cases it is actually right for — you want to
   * edit the copy before it goes, or attach something — but it is no longer
   * the only way out of the queue. A mail sent from the Gmail tab is invisible
   * to this app: no message-id to thread the reply onto, no daily-cap
   * accounting, and "Mark as done" then advances the cadence on your word
   * alone.
   */
  const startDraft = (t: QueueTask) => {
    setDrafts((prev) =>
      prev[t.id]
        ? prev
        : {
            ...prev,
            [t.id]: {
              subject: t.renderedSubject ?? "",
              body: t.renderedBody ?? "",
            },
          },
    );
  };

  const updateDraft = (
    taskId: string,
    patch: Partial<{ subject: string; body: string }>,
  ) => {
    setDrafts((prev) =>
      prev[taskId] ? { ...prev, [taskId]: { ...prev[taskId], ...patch } } : prev,
    );
  };

  const discardDraft = (taskId: string) => {
    setDrafts((prev) => {
      if (!prev[taskId]) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  };

  const sendNow = async (taskId: string) => {
    const draft = drafts[taskId];
    if (draft && !draft.body.trim()) {
      setError("The email body is empty — nothing to send.");
      return;
    }
    setBusyId(taskId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/outreach/sequences/tasks/${taskId}/send`,
        {
          method: "POST",
          headers: headers(),
          // Only when this card was actually edited: an untouched task sends
          // the copy the server already has, so a stale draft can never be
          // what goes out.
          body: draft
            ? JSON.stringify({ subject: draft.subject, body: draft.body })
            : undefined,
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not send");
        return;
      }
      setNotice("Sent — this person moves to the next step");
      discardDraft(taskId);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const openEmailCompose = (
    t: QueueTask,
    copy: { subject: string; body: string },
  ) => {
    const to = t.enrollment?.contactEmail ?? "";
    const { subject, body } = copy;
    const gmail = new URL("https://mail.google.com/mail/");
    gmail.searchParams.set("view", "cm");
    gmail.searchParams.set("fs", "1");
    if (to) gmail.searchParams.set("to", to);
    if (subject) gmail.searchParams.set("su", subject);
    if (body) gmail.searchParams.set("body", body);
    window.open(gmail.toString(), "_blank", "noopener,noreferrer");
  };

  const filteredTasks = useMemo(() => {
    if (activityFilter === "all") return tasks;
    return tasks.filter((t) => t.channel === activityFilter);
  }, [tasks, activityFilter]);

  // An empty queue has nothing to filter, and the chip row hides itself when
  // readyTotal hits 0 — so a user sitting on "Email" when the last task clears
  // would be stranded: the row that holds the way back is gone, and the empty
  // state keeps saying "try All" while offering no All to try (and hiding the
  // Enroll action behind the same condition). Drop the filter instead of the
  // way out of it. Only after loading, or every mount would clear it before
  // the first queue arrives.
  useEffect(() => {
    if (loading) return;
    if (activityFilter !== "all" && (stats?.readyTotal ?? tasks.length) === 0) {
      setActivityFilter("all");
    }
  }, [loading, activityFilter, stats, tasks.length]);

  // Per-sequence counts for today, keyed for the row. The queue endpoint
  // already computes them for the Today tab — the list was simply not reading
  // them, which is why a running cadence and an empty one looked the same.
  const todayBySequence = useMemo(() => {
    const m = new Map<string, DaySequenceStatus>();
    for (const s of stats?.sequences ?? []) m.set(s.id, s);
    return m;
  }, [stats]);

  const seqCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of sequences) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [sequences]);

  // Every tag in use across all campaigns, with how many carry it. Powers both
  // the editor's autocomplete and the list's filter chips, so a tag typed on
  // one campaign is immediately offerable on the next.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sequences)
      for (const t of s.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }));
  }, [sequences]);
  const allTagNames = useMemo(() => allTags.map((t) => t.tag), [allTags]);

  const visibleSequences = useMemo(() => {
    const q = seqQuery.trim().toLowerCase();
    return sequences.filter((s) => {
      if (seqStatus !== "all" && s.status !== seqStatus) return false;
      // OR across selected tags: a campaign matches if it carries any of them.
      if (seqTags.length > 0 && !(s.tags ?? []).some((t) => seqTags.includes(t)))
        return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [sequences, seqQuery, seqStatus, seqTags]);

  // Running first, then the rest in the order the API returned (most recently
  // updated). Sorting the whole list by status would bury a draft you edited
  // thirty seconds ago under ten you have not touched in weeks.
  const [runningSequences, restSequences] = useMemo(
    () => [
      visibleSequences.filter((s) => s.status === "active"),
      visibleSequences.filter((s) => s.status !== "active"),
    ],
    [visibleSequences],
  );

  // A filter that outlives the thing it filtered strands the user on an empty
  // list — same failure the queue chips had. Drop it, not the way out of it.
  useEffect(() => {
    if (loading) return;
    if (seqStatus !== "all" && (seqCounts[seqStatus] ?? 0) === 0) {
      setSeqStatus("all");
    }
    // A tag selected in the filter that no longer exists on any campaign (last
    // carrier deleted or retagged) would otherwise strand the list on empty
    // with a chip you can't even see to unclick.
    if (seqTags.length > 0) {
      const live = seqTags.filter((t) => allTagNames.includes(t));
      if (live.length !== seqTags.length) setSeqTags(live);
    }
  }, [loading, seqStatus, seqCounts, seqTags, allTagNames]);

  const activityLabel = (t: QueueTask) => {
    if (t.channel === "linkedin") {
      return t.step?.linkedinAction === "connect_note"
        ? "Send LinkedIn connection"
        : "Send LinkedIn message";
    }
    return t.mode === "auto" || t.meta?.auto_send_disabled
      ? "Send email (manual)"
      : "Send email";
  };

  if (!token) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════
  // EDITOR — Instantly-style vertical timeline
  // ════════════════════════════════════════════════════════════════
  if (view === "editor" && editingId) {
    const selected =
      editSteps.find((s) => s.key === selectedStepKey) ?? editSteps[0];

    const filteredPeople = enrollments.filter((e) => {
      if (peopleFilter === "all") return true;
      if (peopleFilter === "active") return e.status === "active";
      if (peopleFilter === "completed") return e.status === "completed";
      if (peopleFilter === "bounced")
        return e.status === "bounced" || e.status === "failed";
      return (
        e.status !== "active" &&
        e.status !== "completed" &&
        e.status !== "bounced" &&
        e.status !== "failed"
      );
    });

    const activePeople = enrollments.filter((e) => e.status === "active").length;
    const leadById = new Map(
      (sequenceHealth?.leads ?? []).map((l) => [l.enrollment.id, l]),
    );
    const stepLabel = (pos: number) => {
      const s = editSteps[pos];
      if (!s) return `Step ${pos + 1}`;
      return `Step ${pos + 1} · ${stepTitle(s)}`;
    };

    const healthCards = sequenceHealth
      ? [
          {
            label: "Enrolled",
            value: sequenceHealth.enrollments.total,
            hint: `${sequenceHealth.enrollments.byStatus.active ?? 0} active`,
            warn: false,
          },
          {
            label: "Completed",
            value: sequenceHealth.enrollments.byStatus.completed ?? 0,
            hint: `${sequenceHealth.rates.completionRate}% of leads`,
            warn: false,
          },
          {
            label: "Bounced",
            value: sequenceHealth.enrollments.byStatus.bounced ?? 0,
            hint: `${sequenceHealth.rates.bounceRate}% bounce rate`,
            warn: (sequenceHealth.enrollments.byStatus.bounced ?? 0) > 0,
          },
          {
            label: "Email failed",
            value: sequenceHealth.tasks.email.failed ?? 0,
            hint: `${sequenceHealth.rates.emailFailRate}% of email decisions`,
            warn: (sequenceHealth.tasks.email.failed ?? 0) > 0,
          },
          {
            label: "Emails sent",
            value: sequenceHealth.tasks.email.sent ?? 0,
            hint: `${sequenceHealth.tasks.email.skipped ?? 0} skipped`,
            warn: false,
          },
          {
            label: "Skipped tasks",
            value: sequenceHealth.tasks.byStatus.skipped ?? 0,
            hint: `${sequenceHealth.rates.skipRate}% of finished tasks`,
            warn: false,
          },
        ]
      : [];

    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* Sticky top bar */}
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2"
              onClick={() => {
                setView("list");
                setEditingId(null);
                void load();
              }}
            >
              <ArrowLeft className="size-3.5" />
              Outbound
            </Button>
            <div className="hidden h-4 w-px bg-border sm:block" />
            <div className="min-w-0 flex-1">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-8 border-transparent bg-transparent px-1 text-base font-semibold shadow-none focus-visible:border-border focus-visible:bg-background"
                placeholder="Sequence name"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={editStatus}
                onValueChange={(v) => void changeStatus(v)}
                disabled={busyId === "status"}
              >
                <SelectTrigger className="h-8 w-[120px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              {editStatus !== "active" && editStatus !== "archived" && (
                <Button
                  size="sm"
                  disabled={busyId === "status"}
                  onClick={() => void changeStatus("active")}
                >
                  {busyId === "status" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Activate
                </Button>
              )}
              {editStatus === "active" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === "status"}
                  onClick={() => void changeStatus("paused")}
                >
                  Pause
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEnrollSeqId(editingId);
                  setEnrollOpen(true);
                }}
              >
                <Users className="size-3.5" />
                Enroll list
              </Button>
              {editorTab === "steps" && (
                <Button size="sm" disabled={saving} onClick={() => void saveSequence()}>
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  Save
                </Button>
              )}
              {editingId && (
                <AutoEnrollDialog
                  sequenceId={editingId}
                  sequenceName={editName || "this sequence"}
                  authFetch={(url, init) =>
                    fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } })
                  }
                />
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                title="Delete sequence"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>

          {/* Tags — persist immediately, editable from any tab. */}
          <div className="mx-auto mt-2.5 flex max-w-6xl items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">Tags</span>
            <div className="min-w-0 max-w-lg flex-1">
              <TagEditor
                value={editTags}
                suggestions={allTagNames}
                onChange={(next) => void saveTags(next)}
              />
            </div>
          </div>

          {editStatus !== "active" && (
            <div className="mx-auto mt-3 max-w-6xl rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-pretty text-muted-foreground">
              {editStatus === "draft" && (
                <>
                  <span className="font-medium text-foreground">Draft</span> —
                  you can enroll people and edit steps, but nothing runs until
                  you hit <span className="font-medium text-foreground">Activate</span>.
                </>
              )}
              {editStatus === "paused" && (
                <>
                  <span className="font-medium text-foreground">Paused</span> —
                  people stay enrolled; queue work and auto-email are held.
                  Activate to resume.
                </>
              )}
              {editStatus === "archived" && (
                <>
                  <span className="font-medium text-foreground">Archived</span> —
                  this sequence is inactive. Set Active to run it again, or
                  delete it.
                </>
              )}
            </div>
          )}

          {/* Dashboard | Steps | People tabs */}
          <div className="mx-auto mt-3 flex max-w-6xl gap-1 border-b border-border">
            {(
              [
                ["dashboard", "Dashboard", enrollmentCount],
                ["steps", "Steps", editSteps.length],
                ["people", "People", enrollmentCount],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                onClick={() =>
                  setEditorTab(id as "dashboard" | "steps" | "people")
                }
                className={cn(
                  "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm",
                  editorTab === id
                    ? "border-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                  {count}
                </span>
              </button>
            ))}
          </div>

          {(notice || error) && (
            <div className="mx-auto mt-2 max-w-6xl">
              {notice && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  {notice}
                </p>
              )}
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
            </div>
          )}
        </header>

        {editLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading sequence…
          </div>
        ) : editorTab === "dashboard" ? (
          /* ── Dashboard: health + per-lead progress ── */
          <div className="mx-auto min-h-0 w-full max-w-6xl flex-1 space-y-6 overflow-y-auto px-4 py-6 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Sequence health</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Bounce, failures, skips, and where each lead is in the cadence.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void reloadEnrollments(editingId)}
              >
                <RefreshCw className="size-3.5" />
                Refresh
              </Button>
            </div>

            {!sequenceHealth || sequenceHealth.enrollments.total === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center">
                <Users className="size-8 text-muted-foreground/60" />
                <p className="mt-4 text-sm font-medium">No enrollments yet</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Enroll people from a research list to see health metrics and
                  progress.
                </p>
                <Button
                  className="mt-5"
                  onClick={() => {
                    setEnrollSeqId(editingId);
                    setEnrollOpen(true);
                  }}
                >
                  <Users className="size-3.5" />
                  Enroll from list
                </Button>
              </div>
            ) : (
              <>
                {(sequenceHealth.rates.bounceRate > 5 ||
                  sequenceHealth.rates.emailFailRate > 10 ||
                  (sequenceHealth.enrollments.byStatus.failed ?? 0) > 0) && (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-800 dark:text-rose-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <p className="font-medium">Delivery looks unhealthy</p>
                      <p className="mt-0.5 text-xs opacity-90">
                        Bounce {sequenceHealth.rates.bounceRate}% · email fail{" "}
                        {sequenceHealth.rates.emailFailRate}% · check recent
                        errors below and list quality (valid emails).
                      </p>
                    </div>
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {healthCards.map((c) => (
                    <div
                      key={c.label}
                      className={cn(
                        "rounded-xl border bg-card px-4 py-3",
                        c.warn
                          ? "border-rose-500/40 bg-rose-500/5"
                          : "border-border",
                      )}
                    >
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {c.label}
                      </p>
                      <p
                        className={cn(
                          "mt-1 text-2xl font-semibold tabular-nums",
                          c.warn && "text-rose-700 dark:text-rose-400",
                        )}
                      >
                        {c.value}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {c.hint}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Task breakdown */}
                <div className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Task outcomes
                  </h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ["Email", sequenceHealth.tasks.email],
                        ["LinkedIn", sequenceHealth.tasks.linkedin],
                      ] as const
                    ).map(([label, map]) => (
                      <div key={label}>
                        <p className="text-sm font-medium">{label}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(
                            [
                              ["sent", "Sent"],
                              ["failed", "Failed"],
                              ["skipped", "Skipped"],
                              ["scheduled", "Scheduled"],
                              ["ready", "Ready"],
                            ] as const
                          ).map(([k, lab]) => (
                            <span
                              key={k}
                              className={cn(
                                "rounded-md px-2 py-0.5 text-[11px] tabular-nums",
                                k === "failed" && (map[k] ?? 0) > 0
                                  ? "bg-rose-500/15 text-rose-700 dark:text-rose-400"
                                  : k === "skipped" && (map[k] ?? 0) > 0
                                    ? "bg-amber-500/15 text-amber-800 dark:text-amber-400"
                                    : "bg-muted text-muted-foreground",
                              )}
                            >
                              {lab} {map[k] ?? 0}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Recent errors */}
                {sequenceHealth.recentErrors.length > 0 && (
                  <div className="rounded-xl border border-border bg-card p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Recent errors
                    </h3>
                    <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
                      {sequenceHealth.recentErrors.map((err, i) => (
                        <li
                          key={`${err.at}-${i}`}
                          className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {err.contactName || "—"}
                            </span>
                            <span className="text-muted-foreground">
                              {err.companyName}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {err.channel}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                enrollmentStatusBadge(err.enrollmentStatus),
                              )}
                            >
                              {err.enrollmentStatus}
                            </Badge>
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-rose-700 dark:text-rose-400">
                            {err.error}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Per-lead progress */}
                <div className="rounded-xl border border-border">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h3 className="text-sm font-semibold">Lead progress</h3>
                    <p className="text-[11px] text-muted-foreground">
                      {sequenceHealth.totalSteps} steps · dots = status
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Person</th>
                          <th className="px-2 py-2 font-medium">Status</th>
                          <th className="px-2 py-2 font-medium">Progress</th>
                          <th className="px-2 py-2 font-medium">Steps</th>
                          <th className="px-4 py-2 font-medium">Issue</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {sequenceHealth.leads.map((lead) => {
                          const e = lead.enrollment;
                          return (
                            <tr key={e.id} className="hover:bg-muted/20">
                              <td className="px-4 py-2.5">
                                <p className="truncate font-medium">
                                  {e.contactName || "—"}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {e.companyName}
                                  {e.contactEmail
                                    ? ` · ${e.contactEmail}`
                                    : " · no email"}
                                </p>
                              </td>
                              <td className="px-2 py-2.5">
                                <span
                                  className={cn(
                                    "inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium capitalize",
                                    enrollmentStatusBadge(e.status),
                                  )}
                                >
                                  {e.status}
                                </span>
                              </td>
                              <td className="px-2 py-2.5">
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={cn(
                                        "h-full rounded-full",
                                        e.status === "bounced" ||
                                          e.status === "failed"
                                          ? "bg-rose-500"
                                          : e.status === "completed"
                                            ? "bg-emerald-500"
                                            : "bg-foreground/70",
                                      )}
                                      style={{ width: `${lead.progressPct}%` }}
                                    />
                                  </div>
                                  <span className="text-[11px] tabular-nums text-muted-foreground">
                                    {lead.completedSteps}/{lead.totalSteps}
                                  </span>
                                </div>
                              </td>
                              <td className="px-2 py-2.5">
                                <div className="flex items-center gap-1">
                                  {lead.steps.map((s) => (
                                    <span
                                      key={s.position}
                                      title={`Step ${s.position + 1} ${s.channel}: ${s.status}${s.error ? ` — ${s.error}` : ""}`}
                                      className={cn(
                                        "size-2.5 rounded-full",
                                        stepStatusDot(s.status),
                                        s.channel === "email" &&
                                          "ring-1 ring-offset-1 ring-offset-background ring-foreground/10",
                                      )}
                                    />
                                  ))}
                                </div>
                              </td>
                              <td className="max-w-[180px] px-4 py-2.5">
                                {lead.lastTaskError ? (
                                  <p
                                    className="truncate font-mono text-[10px] text-rose-600 dark:text-rose-400"
                                    title={lead.lastTaskError}
                                  >
                                    {lead.lastTaskError}
                                  </p>
                                ) : !e.contactEmail ? (
                                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                                    No email
                                  </p>
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap gap-3 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-emerald-500" /> sent
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-rose-500" /> failed
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-amber-500" /> skipped
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-sky-500" /> ready
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="size-2 rounded-full bg-muted-foreground/40" />{" "}
                      scheduled / pending
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : editorTab === "people" ? (
          /* ── People: who is running this sequence ── */
          <div className="mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">People in this sequence</h2>
                <p className="mt-0.5 text-xs text-pretty text-muted-foreground">
                  Click a person for the send timeline. {activePeople} active ·{" "}
                  {enrollmentCount} total.
                  {enrollments.filter((e) => !e.contactLinkedin).length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {" "}
                      · {enrollments.filter((e) => !e.contactLinkedin).length}{" "}
                      missing LinkedIn
                    </span>
                  )}
                  {enrollments.filter((e) => !e.contactEmail).length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {" "}
                      · {enrollments.filter((e) => !e.contactEmail).length}{" "}
                      missing email (email steps skipped)
                    </span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void reloadEnrollments(editingId)}
                >
                  <RefreshCw className="size-3.5" />
                  Refresh
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEnrollSeqId(editingId);
                    setEnrollOpen(true);
                  }}
                >
                  <Plus className="size-3.5" />
                  Enroll from list
                </Button>
              </div>
            </div>

            <div className="mb-4 flex flex-wrap gap-1.5">
              {(
                [
                  ["all", "All"],
                  ["active", "Active"],
                  ["completed", "Completed"],
                  ["bounced", "Bounced / failed"],
                  ["other", "Paused / other"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPeopleFilter(id)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium",
                    peopleFilter === id
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {filteredPeople.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
                <Users className="size-8 text-muted-foreground/60" />
                <p className="mt-4 text-sm font-medium">
                  {enrollmentCount === 0
                    ? "Nobody enrolled yet"
                    : "No people in this filter"}
                </p>
                <p className="mt-1 max-w-md text-sm text-pretty text-muted-foreground">
                  {enrollmentCount === 0
                    ? "Click Enroll from list and pick a research list. Every person on those companies is added here and starts the cadence."
                    : "Try another filter."}
                </p>
                {enrollmentCount === 0 && (
                  <Button
                    className="mt-5"
                    onClick={() => {
                      setEnrollSeqId(editingId);
                      setEnrollOpen(true);
                    }}
                  >
                    <Users className="size-3.5" />
                    Enroll from list
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border">
                <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_84px_116px_minmax(0,1.2fr)_212px] gap-3 border-b border-border bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span>Person</span>
                  <span>Company</span>
                  <span>Status</span>
                  <span>Progress</span>
                  <span>Current step</span>
                  <span className="text-right">Actions</span>
                </div>
                <ul className="divide-y divide-border">
                  {filteredPeople.map((e) => {
                    const lead = leadById.get(e.id);
                    const expanded = timelinePersonId === e.id;
                    return (
                      <li key={e.id} className="text-sm">
                        <div
                          className={cn(
                            "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_84px_116px_minmax(0,1.2fr)_212px] items-center gap-3 px-4 py-3",
                            expanded && "bg-muted/20",
                          )}
                        >
                          <button
                            type="button"
                            className="min-w-0 text-left"
                            onClick={() =>
                              setTimelinePersonId(expanded ? null : e.id)
                            }
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate font-medium hover:underline">
                                {e.contactName || "—"}
                              </p>
                              {!e.contactLinkedin && (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                  No LinkedIn
                                </span>
                              )}
                              {!e.contactEmail && (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                  No email
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              {e.contactRole && (
                                <span className="truncate">{e.contactRole}</span>
                              )}
                              {e.contactEmail ? (
                                <span className="truncate font-mono">
                                  {e.contactEmail}
                                </span>
                              ) : (
                                <span className="text-amber-600/90 dark:text-amber-400/90">
                                  email missing
                                </span>
                              )}
                              {e.contactLinkedin ? (
                                <a
                                  href={e.contactLinkedin}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-0.5 text-[#0A66C2] hover:underline"
                                  onClick={(ev) => ev.stopPropagation()}
                                >
                                  <Linkedin className="size-3" />
                                  LI
                                </a>
                              ) : (
                                <span className="text-amber-600/90 dark:text-amber-400/90">
                                  LI missing
                                </span>
                              )}
                              <span className="text-[10px] text-muted-foreground/80">
                                {expanded ? "Hide timeline" : "Timeline"}
                              </span>
                            </div>
                          </button>
                          <div className="min-w-0">
                            <p className="truncate">{e.companyName}</p>
                            {e.domain && (
                              <p className="truncate font-mono text-[11px] text-muted-foreground">
                                {e.domain}
                              </p>
                            )}
                          </div>
                          <div>
                            <span
                              className={cn(
                                "inline-flex rounded-full px-2 py-0.5 text-[11px] capitalize",
                                enrollmentStatusBadge(e.status),
                              )}
                            >
                              {e.status}
                            </span>
                          </div>
                          <div className="min-w-0">
                            {!lead ? (
                              <span className="text-[11px] text-muted-foreground">
                                —
                              </span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-1">
                                  {lead.steps.map((s) => (
                                    <span
                                      key={s.position}
                                      title={`Step ${s.position + 1} ${s.channel}: ${s.status}`}
                                      className={cn(
                                        "size-2 rounded-full",
                                        stepStatusDot(s.status),
                                      )}
                                    />
                                  ))}
                                </div>
                                <span className="text-[10px] tabular-nums text-muted-foreground">
                                  {lead.completedSteps}/{lead.totalSteps} ·{" "}
                                  {lead.progressPct}%
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 text-xs text-muted-foreground">
                            <p className="truncate text-foreground">
                              {e.status === "completed"
                                ? "Finished"
                                : stepLabel(e.currentStepPosition)}
                            </p>
                            {e.status === "active" && e.nextRunAt ? (
                              <p className="truncate text-[11px] tabular-nums text-muted-foreground">
                                Next{" "}
                                {new Date(e.nextRunAt).toLocaleDateString(
                                  undefined,
                                  { month: "short", day: "numeric" },
                                )}
                              </p>
                            ) : null}
                            {e.lastError && (
                              <p className="truncate text-destructive">
                                {e.lastError}
                              </p>
                            )}
                          </div>
                          <div>
                            <div className="flex items-center justify-end gap-0.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-[11px]"
                                disabled={busyId === e.id}
                                title="Create or update this company in CRM Accounts"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  void promoteEnrollmentToCrm(e);
                                }}
                              >
                                {busyId === e.id ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  "To CRM"
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => {
                                  setPreviewPersonId(e.id);
                                  setEditorTab("steps");
                                }}
                              >
                                Preview
                              </Button>
                              {e.status === "active" && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 text-muted-foreground"
                                  disabled={busyId === e.id}
                                  onClick={() => void pauseEnrollment(e, true)}
                                  aria-label={`Pause ${e.contactName || "person"}`}
                                  title="Pause this person"
                                >
                                  {busyId === e.id ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Pause className="size-3.5" />
                                  )}
                                </Button>
                              )}
                              {e.status === "paused" && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 text-muted-foreground"
                                  disabled={busyId === e.id}
                                  onClick={() => void pauseEnrollment(e, false)}
                                  aria-label={`Resume ${e.contactName || "person"}`}
                                  title="Resume this person"
                                >
                                  {busyId === e.id ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Play className="size-3.5" />
                                  )}
                                </Button>
                              )}
                              {(e.status === "active" ||
                                e.status === "paused") && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 text-muted-foreground hover:text-destructive"
                                  disabled={busyId === e.id}
                                  onClick={() => void removeEnrollment(e)}
                                  aria-label={`Remove ${e.contactName || "person"} from campaign`}
                                >
                                  {busyId === e.id ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="size-3.5" />
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>

                        {expanded && (
                          <div className="border-t border-border bg-muted/15 px-4 py-4">
                            <p className="mb-3 text-xs font-medium text-muted-foreground">
                              Activity timeline — what went out (or will) for this
                              person
                            </p>
                            {!lead || lead.steps.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                No step history yet.
                              </p>
                            ) : (
                              <ol className="relative space-y-0 border-l border-border pl-4">
                                {lead.steps.map((s) => {
                                  const when =
                                    s.sentAt ||
                                    (s.status === "ready" ||
                                    s.status === "scheduled"
                                      ? s.scheduledFor
                                      : null);
                                  return (
                                    <li
                                      key={s.position}
                                      className="relative pb-4 last:pb-0"
                                    >
                                      <span
                                        className={cn(
                                          "absolute -left-[1.3rem] top-1 size-2.5 rounded-full ring-2 ring-background",
                                          stepStatusDot(s.status),
                                        )}
                                      />
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs font-semibold">
                                          Step {s.position + 1} ·{" "}
                                          {stepChannelLabel(s)}
                                        </span>
                                        <span
                                          className={cn(
                                            "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                                            s.status === "sent"
                                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                              : s.status === "failed" ||
                                                  s.status === "bounced"
                                                ? "bg-rose-500/15 text-rose-700 dark:text-rose-400"
                                                : s.status === "ready"
                                                  ? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
                                                  : "bg-muted text-muted-foreground",
                                          )}
                                        >
                                          {stepStatusLabel(s.status)}
                                        </span>
                                        <span className="text-[11px] tabular-nums text-muted-foreground">
                                          {formatTaskWhen(when)}
                                        </span>
                                      </div>
                                      {s.subject && (
                                        <p className="mt-1 text-xs font-medium text-foreground/90">
                                          {s.subject}
                                        </p>
                                      )}
                                      {s.bodySnippet && (
                                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                                          {s.bodySnippet}
                                        </p>
                                      )}
                                      {s.error && (
                                        <p className="mt-1 font-mono text-[11px] text-rose-600 dark:text-rose-400">
                                          {s.error}
                                        </p>
                                      )}
                                    </li>
                                  );
                                })}
                              </ol>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        ) : (
          /* Instantly-style vertical sequence builder */
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6">
              {/* Meta */}
              <div className="mb-6 space-y-3">
                <Input
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Description (optional)"
                  className="h-9 border-border/60 bg-transparent text-sm"
                />
                <div className="flex items-center gap-2">
                  <Mail className="size-3.5 text-muted-foreground" />
                  <Select value={editMailboxId} onValueChange={setEditMailboxId}>
                    <SelectTrigger className="h-8 w-full max-w-sm text-xs">
                      <SelectValue placeholder="Choose sender" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Workspace default mailbox</SelectItem>
                      {mailboxes
                        .filter((mailbox) => mailbox.enabled && mailbox.connected)
                        .map((mailbox) => (
                          <SelectItem key={mailbox.id} value={mailbox.id}>
                            {mailbox.label} · {mailbox.fromEmail}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {editSteps.length} step{editSteps.length === 1 ? "" : "s"}
                    {activePeople > 0
                      ? ` · ${activePeople} people active`
                      : " · enroll people when ready"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => {
                        const s = blankStep("linkedin");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                    >
                      <Linkedin className="size-3.5 text-[#0A66C2]" />
                      LinkedIn step
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => {
                        const s = blankStep("email");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                    >
                      <Mail className="size-3.5 text-amber-600" />
                      Email step
                    </Button>
                  </div>
                </div>
              </div>

              {/* Vertical timeline */}
              <div className="relative space-y-0">
                {editSteps.map((step, idx) => {
                  const isSel = selected?.key === step.key;
                  const waitDays = Math.floor(step.delayHours / 24);
                  const waitHours = step.delayHours % 24;
                  const hasPreviousEmail = editSteps
                    .slice(0, idx)
                    .some((candidate) => candidate.channel === "email");
                  const previewPerson =
                    previewPersonId === "sample"
                      ? {
                          companyName: "Acme QA",
                          domain: "acme.com",
                          contactName: "Alex Chen",
                          contactEmail: "alex@acme.com",
                          contactLinkedin: "https://linkedin.com/in/alex",
                          contactRole: "Head of QA",
                          templateVars: {
                            public_trigger:
                              "Alex shared a public post about AI-assisted engineering reviews | https://example.com/post | 2026-08-01",
                          },
                        }
                      : (() => {
                          const e = enrollments.find(
                            (x) => x.id === previewPersonId,
                          );
                          return e
                            ? {
                                companyName: e.companyName,
                                domain: e.domain,
                                contactName: e.contactName,
                                contactEmail: e.contactEmail,
                                contactLinkedin: e.contactLinkedin,
                                contactRole: e.contactRole,
                                // Every product token — signup date, tier,
                                // dev_count — is backed by this. Without it the
                                // preview showed a real person's name beside
                                // raw {{signup_date}}, which reads as "the
                                // token is broken" rather than "the preview
                                // dropped it".
                                templateVars: e.templateVars,
                              }
                            : {
                                companyName: "Acme QA",
                                domain: "acme.com",
                                contactName: "Alex Chen",
                                contactEmail: "alex@acme.com",
                                contactLinkedin:
                                  "https://linkedin.com/in/alex",
                                contactRole: "Head of QA",
                                templateVars: {
                                  public_trigger:
                                    "Alex shared a public post about AI-assisted engineering reviews | https://example.com/post | 2026-08-01",
                                },
                              };
                        })();
                  const renderedBody = renderTemplate(
                    step.bodyTemplate,
                    previewPerson,
                  );
                  const renderedSubject =
                    step.channel === "email" && step.subjectTemplate
                      ? renderTemplate(step.subjectTemplate, previewPerson)
                      : null;

                  return (
                    <div key={step.key} className="relative">
                      {/* Wait connector between steps */}
                      {idx > 0 && (
                        <div className="flex items-center gap-3 py-2 pl-4">
                          <div className="flex w-8 flex-col items-center">
                            <div className="h-4 w-px bg-border" />
                          </div>
                          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
                            <Clock className="size-3" />
                            Wait {formatWait(step.delayHours).toLowerCase()}
                          </div>
                        </div>
                      )}

                      <div className="flex gap-3">
                        {/* Timeline rail */}
                        <div className="flex w-8 shrink-0 flex-col items-center pt-3">
                          <div
                            className={cn(
                              "z-[1] flex size-8 items-center justify-center rounded-full border-2 text-xs font-semibold tabular-nums",
                              isSel
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-background text-muted-foreground",
                            )}
                          >
                            {idx + 1}
                          </div>
                          {idx < editSteps.length - 1 && !isSel && (
                            <div className="w-px flex-1 bg-border" />
                          )}
                          {idx < editSteps.length - 1 && isSel && (
                            <div className="w-px flex-1 bg-border" />
                          )}
                        </div>

                        {/* Step card */}
                        <div
                          className={cn(
                            "mb-1 min-w-0 flex-1 overflow-hidden rounded-xl border transition",
                            isSel
                              ? "border-foreground/20 bg-card shadow-sm"
                              : "border-border bg-card/60 hover:border-foreground/15 hover:bg-card",
                          )}
                        >
                          {/* Collapsed header — always visible */}
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedStepKey(isSel ? step.key : step.key)
                            }
                            className="flex w-full items-start gap-3 p-4 text-left"
                          >
                            <span
                              className={cn(
                                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                                step.channel === "linkedin"
                                  ? "bg-[#0A66C2]/12 text-[#0A66C2]"
                                  : "bg-amber-500/12 text-amber-600 dark:text-amber-400",
                              )}
                            >
                              {step.channel === "linkedin" ? (
                                <Linkedin className="size-4" />
                              ) : (
                                <Mail className="size-4" />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold">
                                  {stepTitle(step)}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {idx === 0
                                    ? "Day 0 · on enroll"
                                    : formatWait(step.delayHours)}
                                  {step.channel === "linkedin"
                                    ? " · manual"
                                    : step.mode === "auto"
                                      ? " · auto"
                                      : " · manual"}
                                </span>
                              </div>
                              {!isSel && (
                                <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                                  {step.channel === "email" &&
                                  step.subjectTemplate
                                    ? `${step.subjectTemplate} — `
                                    : ""}
                                  {step.bodyTemplate || "Empty message…"}
                                </p>
                              )}
                            </div>
                          </button>

                          {/* Expanded editor */}
                          {isSel && (
                            <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <Segmented
                                  value={step.channel}
                                  onChange={(v) =>
                                    updateStep(step.key, { channel: v })
                                  }
                                  options={[
                                    {
                                      value: "linkedin" as const,
                                      label: "LinkedIn",
                                      icon: <Linkedin className="size-3" />,
                                    },
                                    {
                                      value: "email" as const,
                                      label: "Email",
                                      icon: <Mail className="size-3" />,
                                    },
                                  ]}
                                />
                                <div className="flex gap-0.5">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="size-8 p-0"
                                    disabled={idx === 0}
                                    aria-label="Move up"
                                    onClick={() =>
                                      setEditSteps((prev) => {
                                        if (idx === 0) return prev;
                                        const n = [...prev];
                                        [n[idx - 1], n[idx]] = [
                                          n[idx],
                                          n[idx - 1],
                                        ];
                                        return normalizeFirstEmailThreadMode(n);
                                      })
                                    }
                                  >
                                    <ArrowUp className="size-3.5" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="size-8 p-0"
                                    disabled={idx === editSteps.length - 1}
                                    aria-label="Move down"
                                    onClick={() =>
                                      setEditSteps((prev) => {
                                        if (idx >= prev.length - 1)
                                          return prev;
                                        const n = [...prev];
                                        [n[idx], n[idx + 1]] = [
                                          n[idx + 1],
                                          n[idx],
                                        ];
                                        return normalizeFirstEmailThreadMode(n);
                                      })
                                    }
                                  >
                                    <ArrowDown className="size-3.5" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="size-8 p-0 text-muted-foreground hover:text-destructive"
                                    disabled={editSteps.length <= 1}
                                    aria-label="Delete step"
                                    onClick={() => {
                                      setEditSteps((p) => {
                                        const next = p.filter(
                                          (x) => x.key !== step.key,
                                        );
                                        setSelectedStepKey(
                                          next[Math.max(0, idx - 1)]?.key ??
                                            next[0]?.key ??
                                            null,
                                        );
                                        return normalizeFirstEmailThreadMode(next);
                                      });
                                    }}
                                  >
                                    <Trash2 className="size-3.5" />
                                  </Button>
                                </div>
                              </div>

                              {step.channel === "linkedin" ? (
                                <div className="space-y-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Action
                                  </p>
                                  <Segmented
                                    value={
                                      step.linkedinAction ?? "connect_note"
                                    }
                                    onChange={(v) =>
                                      updateStep(step.key, {
                                        linkedinAction: v,
                                      })
                                    }
                                    options={[
                                      {
                                        value: "connect_note" as const,
                                        label: "Connection + note",
                                      },
                                      {
                                        value: "message" as const,
                                        label: "Message",
                                      },
                                    ]}
                                  />
                                </div>
                              ) : (
                                <div className="space-y-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Send mode
                                  </p>
                                  <Segmented
                                    value={step.mode}
                                    onChange={(v) =>
                                      updateStep(step.key, { mode: v })
                                    }
                                    options={[
                                      {
                                        value: "auto" as const,
                                        label: "Auto-send",
                                      },
                                      {
                                        value: "semi" as const,
                                        label: "Manual",
                                      },
                                    ]}
                                  />
                                </div>
                              )}

                              {step.channel === "email" && (
                                <div className="space-y-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Conversation
                                  </p>
                                  {hasPreviousEmail ? (
                                    <Segmented
                                      value={step.emailThreadMode}
                                      onChange={(v) =>
                                        updateStep(step.key, {
                                          emailThreadMode: v,
                                        })
                                      }
                                      options={[
                                        {
                                          value: "new" as const,
                                          label: "New thread",
                                        },
                                        {
                                          value: "reply" as const,
                                          label: "Reply in thread",
                                        },
                                      ]}
                                    />
                                  ) : (
                                    <p className="text-xs text-muted-foreground">
                                      First email always starts a new conversation.
                                    </p>
                                  )}
                                  <p className="text-[11px] text-muted-foreground">
                                    {!hasPreviousEmail
                                      ? "Follow-up email steps can reply in this thread."
                                      : step.emailThreadMode === "reply"
                                        ? "Reply to the previous email for this lead. Subject is set to Re: … from that step (you can still edit)."
                                        : "Starts a brand-new conversation. Use your own subject."}
                                  </p>
                                </div>
                              )}

                              <div className="space-y-1.5">
                                <p className="text-[11px] font-medium text-muted-foreground">
                                  Delay after previous step
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1">
                                    <Input
                                      type="number"
                                      min={0}
                                      className="h-7 w-12 border-0 p-0 text-sm shadow-none focus-visible:ring-0"
                                      value={waitDays}
                                      onChange={(e) =>
                                        updateStep(step.key, {
                                          delayHours:
                                            Math.max(
                                              0,
                                              Number(e.target.value) || 0,
                                            ) *
                                              24 +
                                            waitHours,
                                        })
                                      }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                      d
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1">
                                    <Input
                                      type="number"
                                      min={0}
                                      max={23}
                                      className="h-7 w-12 border-0 p-0 text-sm shadow-none focus-visible:ring-0"
                                      value={waitHours}
                                      onChange={(e) =>
                                        updateStep(step.key, {
                                          delayHours:
                                            waitDays * 24 +
                                            Math.max(
                                              0,
                                              Number(e.target.value) || 0,
                                            ),
                                        })
                                      }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                      h
                                    </span>
                                  </div>
                                  {(
                                    [
                                      [0, "Now"],
                                      [24, "1d"],
                                      [48, "2d"],
                                      [72, "3d"],
                                      [168, "1w"],
                                    ] as const
                                  ).map(([h, label]) => (
                                    <button
                                      key={h}
                                      type="button"
                                      onClick={() =>
                                        updateStep(step.key, {
                                          delayHours: h,
                                        })
                                      }
                                      className={cn(
                                        "rounded-md px-2 py-1 text-[11px] font-medium",
                                        step.delayHours === h
                                          ? "bg-foreground text-background"
                                          : "bg-muted text-muted-foreground hover:text-foreground",
                                      )}
                                    >
                                      {label}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {step.channel === "email" && (
                                <div className="space-y-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    Subject
                                  </p>
                                  <Input
                                    value={step.subjectTemplate}
                                    onChange={(e) =>
                                      updateStep(step.key, {
                                        subjectTemplate: e.target.value,
                                      })
                                    }
                                    placeholder="Subject…"
                                  />
                                </div>
                              )}

                              <div className="space-y-1.5">
                                <div className="flex justify-between">
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    {step.channel === "linkedin"
                                      ? step.linkedinAction === "connect_note"
                                        ? "Connection note"
                                        : "Message"
                                      : "Email body"}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {"{{first_name}} {{company}} …"}
                                  </p>
                                </div>
                                <Textarea
                                  value={step.bodyTemplate}
                                  onChange={(e) =>
                                    updateStep(step.key, {
                                      bodyTemplate: e.target.value,
                                    })
                                  }
                                  rows={step.channel === "email" ? 7 : 4}
                                  className="resize-y text-sm leading-relaxed"
                                />
                                <TokenCatalog />
                              </div>

                              {/* Live preview strip */}
                              <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5">
                                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    Preview
                                  </p>
                                  <Select
                                    value={previewPersonId}
                                    onValueChange={(v) =>
                                      setPreviewPersonId(
                                        v as string | "sample",
                                      )
                                    }
                                  >
                                    <SelectTrigger className="h-7 w-auto min-w-[140px] border-0 bg-transparent text-[11px] shadow-none">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="sample">
                                        Sample · Alex
                                      </SelectItem>
                                      {enrollments
                                        .filter(
                                          (e) =>
                                            e.status === "active" ||
                                            e.status === "paused",
                                        )
                                        .map((e) => (
                                          <SelectItem key={e.id} value={e.id}>
                                            {e.contactName || e.companyName}
                                          </SelectItem>
                                        ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                {renderedSubject && (
                                  <p className="mb-1 text-xs font-medium">
                                    {renderedSubject}
                                  </p>
                                )}
                                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                                  {renderedBody || "…"}
                                </pre>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Add step */}
                <div className="flex items-center gap-3 pt-4">
                  <div className="flex w-8 justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        const s = blankStep("linkedin");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                      className="flex size-8 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
                      aria-label="Add step"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const s = blankStep("linkedin");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      + LinkedIn step
                    </button>
                    <span className="text-muted-foreground/40">·</span>
                    <button
                      type="button"
                      onClick={() => {
                        const s = blankStep("email");
                        setEditSteps((p) => [...p, s]);
                        setSelectedStepKey(s.key);
                      }}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      + Email step
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <EnrollDialog
          open={enrollOpen}
          onOpenChange={setEnrollOpen}
          sequences={sequences}
          tables={tables}
          enrollSeqId={enrollSeqId}
          setEnrollSeqId={setEnrollSeqId}
          enrollTableId={enrollTableId}
          setEnrollTableId={setEnrollTableId}
          enrolling={enrolling}
          onEnroll={() => void enroll()}
          hideSequencePick
        />

        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete sequence?</DialogTitle>
              <DialogDescription>
                This permanently removes{" "}
                <span className="font-medium text-foreground">
                  {editName || "this sequence"}
                </span>
                , all steps, {enrollmentCount} enrolled{" "}
                {enrollmentCount === 1 ? "person" : "people"}, and their queue
                tasks. This cannot be undone. Prefer{" "}
                <span className="font-medium text-foreground">Archived</span>{" "}
                status if you only want to hide it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={deleting}
                onClick={() => setDeleteOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={deleting}
                onClick={() => void deleteSequence()}
              >
                {deleting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Delete forever
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════
  // LIST + QUEUE
  // ════════════════════════════════════════════════════════════════
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            Sequences
          </h1>
          <p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
            Build cadences, enroll lists, and run LinkedIn and email from one
            board.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load()}
            aria-label="Refresh"
            title="Refresh"
            className="text-muted-foreground"
          >
            <RefreshCw
              className={cn("size-3.5", loading && "animate-spin")}
            />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEnrollSeqId(sequences[0]?.id ?? "");
              setEnrollOpen(true);
            }}
          >
            <Users className="size-3.5" />
            Enroll
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New sequence
          </Button>
        </div>
      </div>

      {!mailboxConfigured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-pretty">
          Connect Gmail in{" "}
          <a href="/settings" className="font-medium underline underline-offset-2">
            Settings
          </a>{" "}
          so email steps can auto-send.
        </div>
      )}

      {(notice || error) && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            error
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-border bg-muted/40",
          )}
        >
          {error ?? notice}
        </div>
      )}

      {/* Tabs — Today first */}
      <div className="flex gap-1 border-b border-border">
        {(
          [
            [
              "queue",
              "Today",
              stats?.readyTotal ?? tasks.length,
              Check,
            ],
            ["list", "Sequences", sequences.length, Workflow],
          ] as const
        ).map(([id, label, count, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={cn(
              "inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors",
              view === id
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                view === id ? "bg-foreground/10" : "bg-muted",
              )}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {view === "list" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Toolbar. Search is the first control because with eleven cadences
              named "t0 · … / t2 · … / t3 · …" the name is what you actually
              remember; the status chips answer the other question, which is
              what is live right now. Both hidden below four sequences — a
              filter bar over three rows is furniture. */}
          {sequences.length > 3 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-48 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={seqQuery}
                    onChange={(e) => setSeqQuery(e.target.value)}
                    placeholder="Search sequences…"
                    aria-label="Search sequences by name or description"
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                <Segmented
                  value={seqStatus}
                  onChange={setSeqStatus}
                  options={[
                    { value: "all" as const, label: `All ${sequences.length}` },
                    // Only statuses that exist get a chip: an "Archived 0" button
                    // is a control that can only ever empty the list.
                    ...SEQ_STATUS_ORDER.filter(
                      (s) => (seqCounts[s] ?? 0) > 0,
                    ).map((s) => ({
                      value: s as SeqStatusFilter,
                      label: `${SEQ_STATUS_LABEL[s]} ${seqCounts[s]}`,
                    })),
                  ]}
                />
              </div>

              {/* Tag filter — OR across selections. Only rendered once at least
                  one campaign is tagged; a "Tags" row with nothing to pick is
                  furniture. */}
              {allTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-0.5 text-xs text-muted-foreground">
                    Tags
                  </span>
                  {allTags.map(({ tag, count }) => {
                    const active = seqTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          setSeqTags((prev) =>
                            prev.includes(tag)
                              ? prev.filter((t) => t !== tag)
                              : [...prev, tag],
                          )
                        }
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                          active
                            ? "bg-foreground text-background"
                            : "bg-muted text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {tag}
                        <span
                          className={cn(
                            "tabular-nums",
                            active
                              ? "text-background/70"
                              : "text-muted-foreground/60",
                          )}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                  {seqTags.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSeqTags([])}
                      className="ml-0.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto pb-8">
          {loading && sequences.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Loading…
            </div>
          ) : sequences.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                <Workflow className="size-5 text-muted-foreground" />
              </div>
              <p className="mt-4 text-sm font-medium">No sequences yet</p>
              <p className="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">
                Create a cadence with LinkedIn and email steps, then enroll a
                research list.
              </p>
              <Button className="mt-5" onClick={() => setCreateOpen(true)}>
                <Plus className="size-3.5" />
                New sequence
              </Button>
            </div>
          ) : visibleSequences.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No sequence matches{" "}
                {seqQuery.trim() ? (
                  <span className="text-foreground">
                    &ldquo;{seqQuery.trim()}&rdquo;
                  </span>
                ) : (
                  "this filter"
                )}
                .
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => {
                  setSeqQuery("");
                  setSeqStatus("all");
                  setSeqTags([]);
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            // Each group is one bordered container with hairline dividers — a
            // list, not a heap of cards. The heading only appears when both
            // groups exist; over a single group it would just label a decision
            // you already made with the filter.
            <div className="space-y-6">
              {runningSequences.length > 0 && (
                <section className="space-y-2">
                  {restSequences.length > 0 && (
                    <h2 className="flex items-center gap-2 px-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      <span className="size-1.5 rounded-full bg-emerald-500" />
                      Running
                      <span className="tabular-nums text-muted-foreground/50">
                        {runningSequences.length}
                      </span>
                    </h2>
                  )}
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/50">
                    {runningSequences.map((s) => (
                      <SequenceRow
                        key={s.id}
                        sequence={s}
                        today={todayBySequence.get(s.id)}
                        onOpen={() => void openEditor(s.id)}
                      />
                    ))}
                  </div>
                </section>
              )}
              {restSequences.length > 0 && (
                <section className="space-y-2">
                  {runningSequences.length > 0 && (
                    <h2 className="flex items-center gap-2 px-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Not running
                      <span className="tabular-nums text-muted-foreground/50">
                        {restSequences.length}
                      </span>
                    </h2>
                  )}
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/50">
                    {restSequences.map((s) => (
                      <SequenceRow
                        key={s.id}
                        sequence={s}
                        today={todayBySequence.get(s.id)}
                        onOpen={() => void openEditor(s.id)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
          </div>
        </div>
      )}

      {view === "queue" && (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto pb-8">
          {/* Status line, then capacity, then the work.
              This used to be three cards of equal weight — inboxes, auto email,
              human queue — which gave a background process the same visual claim
              as the list you are here to work. It also spent the largest type on
              the page rendering "0 · 0 · 0", so the most prominent thing on
              screen was the absence of work.
              Now: one sentence says what today is, the numbers that need a
              decision are the only ones emphasised, and everything else is
              support text or hidden until it matters. */}
          <QueueStatus
            stats={stats}
            taskCount={tasks.length}
            failed={queueFailed}
          />
          {stats && !stats.emailAutoSend && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Email auto-send is{" "}
              <span className="font-medium text-foreground">off</span> — due
              emails land here for you to send. Change in{" "}
              <a
                href="/settings"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Settings → Outreach email
              </a>
              .
            </div>
          )}

          {/* Filters — hidden when there is nothing to filter. Three chips
              reading "All · 0 · LinkedIn · 0 · Email · 0" are three more zeros
              and no available action. */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-2",
              (stats?.readyTotal ?? tasks.length) === 0 && "hidden",
            )}
          >
            <span className="text-xs text-muted-foreground">Show</span>
            {(
              [
                ["all", "All"],
                ["linkedin", "LinkedIn"],
                ["email", "Email"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActivityFilter(id)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium",
                  activityFilter === id
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {id === "all" && stats
                  ? ` · ${stats.readyTotal}`
                  : id === "linkedin" && stats
                    ? ` · ${stats.readyLinkedin}`
                    : id === "email" && stats
                      ? ` · ${stats.readyEmail}`
                      : ""}
              </button>
            ))}
          </div>

          {loading && tasks.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Loading today&apos;s work…
            </div>
          ) : filteredTasks.length === 0 ? (
            // The status line above already says the queue is empty; a large
            // dashed box with a green tick repeats it in the loudest way
            // available, and celebrates having nothing to do. What is useful
            // here is the way out, so that is all that stays.
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-6 text-sm text-muted-foreground">
              <span>
                {activityFilter === "all"
                  ? "Delayed steps will appear here as they come due."
                  : "No work of this kind due — try All."}
              </span>
              {activityFilter === "all" ? (
                <button
                  type="button"
                  onClick={() => {
                    setEnrollSeqId(sequences[0]?.id ?? "");
                    setEnrollOpen(true);
                  }}
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Enroll a list
                </button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Work top → bottom. For LinkedIn: open profile → paste note →
                send on LinkedIn →{" "}
                <span className="font-medium text-foreground">
                  Mark as done here
                </span>{" "}
                so the sequence advances.
              </p>
              {filteredTasks.map((t, idx) => {
                const e = t.enrollment;
                const profile =
                  (t.meta?.profile_url as string) ||
                  e?.contactLinkedin ||
                  null;
                const isLi = t.channel === "linkedin";
                const liAction =
                  t.step?.linkedinAction === "connect_note"
                    ? "connection request"
                    : "message";
                const draft = drafts[t.id];
                // What will actually be sent, and therefore what Copy and
                // "Open Gmail" have to show — otherwise the buttons next to an
                // edited card quietly hand back the original text.
                const subject = draft?.subject ?? t.renderedSubject ?? "";
                const body = draft?.body ?? t.renderedBody ?? "";
                // Tokens the enrollment had no value for. The renderer leaves
                // them as {{token}} instead of blanking them, so the hole is
                // visible in the copy above and the send stays blocked until
                // someone writes over it.
                const unfilled = findUnresolvedTokens(subject, body);
                return (
                  <div
                    key={t.id}
                    className={cn(
                      "overflow-hidden rounded-xl border bg-card",
                      isLi
                        ? "border-[#0A66C2]/25"
                        : "border-border",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/20 px-4 py-2.5">
                      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
                        {idx + 1}
                      </span>
                      <div
                        className={cn(
                          "flex size-7 items-center justify-center rounded-md",
                          isLi
                            ? "bg-[#0A66C2]/15 text-[#0A66C2]"
                            : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                        )}
                      >
                        {isLi ? (
                          <Linkedin className="size-3.5" />
                        ) : (
                          <Mail className="size-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">
                          {activityLabel(t)}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {e?.contactName ?? "—"}
                          {e?.contactRole ? ` · ${e.contactRole}` : ""}
                          {e?.companyName ? ` @ ${e.companyName}` : ""}
                          {t.sequenceName ? ` · ${t.sequenceName}` : ""}
                        </p>
                      </div>
                      {isLi && (
                        <span className="rounded-full bg-[#0A66C2]/10 px-2 py-0.5 text-[10px] font-medium text-[#0A66C2]">
                          Manual on LinkedIn
                        </span>
                      )}
                    </div>
                    <div className="px-4 py-3">
                      {draft ? (
                        <div className="space-y-2">
                          <Input
                            value={draft.subject}
                            onChange={(ev) =>
                              updateDraft(t.id, { subject: ev.target.value })
                            }
                            placeholder="Subject"
                            className="text-sm font-medium"
                          />
                          <Textarea
                            value={draft.body}
                            onChange={(ev) =>
                              updateDraft(t.id, { body: ev.target.value })
                            }
                            rows={10}
                            className="text-sm leading-relaxed"
                          />
                          <p className="text-[11px] text-muted-foreground">
                            Editing this email only — the sequence step stays as
                            it is, and everyone else still gets the template.
                            Nothing is saved until you send.
                          </p>
                        </div>
                      ) : (
                        <>
                          {!isLi && t.renderedSubject && (
                            <p className="mb-2 text-sm font-medium">
                              {t.renderedSubject}
                            </p>
                          )}
                          <pre className="whitespace-pre-wrap text-sm leading-relaxed text-pretty text-foreground/90">
                            {t.renderedBody}
                          </pre>
                        </>
                      )}

                      {unfilled.length > 0 && (
                        <div className="mt-3 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                          <div className="min-w-0 space-y-1">
                            <p className="text-xs font-medium text-destructive">
                              {unfilled.length === 1
                                ? "1 variable has no value for this account"
                                : `${unfilled.length} variables have no value for this account`}
                              {isLi ? "" : " — sending is blocked"}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {unfilled.map((v) => `{{${v}}}`).join(", ")} —{" "}
                              {isLi
                                ? "rewrite the note before you paste it into LinkedIn."
                                : "click Edit and write over it, or fill the data on the account and refresh."}
                            </p>
                          </div>
                        </div>
                      )}

                      {isLi ? (
                        <div className="mt-4 space-y-3 rounded-lg border border-[#0A66C2]/20 bg-[#0A66C2]/5 px-3 py-3">
                          <p className="text-xs font-medium text-foreground">
                            How to finish this step
                          </p>
                          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                            <li>
                              Open their LinkedIn and send the{" "}
                              <span className="text-foreground">{liAction}</span>
                            </li>
                            <li>Copy the note below if you need it</li>
                            <li>
                              Come back here and click{" "}
                              <span className="font-medium text-foreground">
                                Mark as done
                              </span>{" "}
                              — that advances the sequence
                            </li>
                          </ol>
                          <div className="flex flex-wrap gap-2 pt-1">
                            {profile && (
                              <Button size="sm" variant="outline" asChild>
                                <a
                                  href={profile}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <ExternalLink className="size-3.5" />
                                  Open LinkedIn profile
                                </a>
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                void copyText(t.renderedBody ?? "");
                              }}
                            >
                              <Copy className="size-3.5" />
                              Copy note
                            </Button>
                            <Button
                              size="sm"
                              className="bg-[#0A66C2] text-white hover:bg-[#0A66C2]/90"
                              disabled={busyId === t.id}
                              onClick={() => void complete(t.id, "sent")}
                            >
                              {busyId === t.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Check className="size-3.5" />
                              )}
                              Mark as done
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busyId === t.id}
                              onClick={() => void complete(t.id, "skipped")}
                            >
                              <SkipForward className="size-3.5" />
                              Skip step
                            </Button>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            LinkedIn is manual — the app only knows you finished
                            when you press{" "}
                            <span className="font-medium text-foreground">
                              Mark as done
                            </span>
                            .
                          </p>
                        </div>
                      ) : (
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          {e?.contactEmail && (
                            <Button
                              size="sm"
                              disabled={
                                busyId === t.id ||
                                !mailboxConfigured ||
                                unfilled.length > 0
                              }
                              onClick={() => void sendNow(t.id)}
                              title={
                                unfilled.length > 0
                                  ? `Blocked: ${unfilled
                                      .map((v) => `{{${v}}}`)
                                      .join(", ")} has no value for this account`
                                  : mailboxConfigured
                                    ? `Send now from the sequence's mailbox to ${e.contactEmail}`
                                    : "Connect Gmail in Settings to send from here"
                              }
                            >
                              {busyId === t.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Send className="size-3.5" />
                              )}
                              Send now
                            </Button>
                          )}
                          {/* Editing here keeps the send inside the app —
                              which is the whole point: "Open Gmail" was the
                              only way to change a word, and it costs the
                              message-id, the cap accounting and the CRM
                              record. */}
                          {draft ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === t.id}
                              onClick={() => discardDraft(t.id)}
                              title="Drop your changes and go back to the sequence copy"
                            >
                              <RefreshCw className="size-3.5" />
                              Reset copy
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === t.id}
                              onClick={() => startDraft(t)}
                              title="Edit the subject and body before sending"
                            >
                              <Pencil className="size-3.5" />
                              Edit
                            </Button>
                          )}
                          {e?.contactEmail && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                openEmailCompose(t, { subject, body })
                              }
                              title="Compose in Gmail instead — use this when you want to edit or attach something first"
                            >
                              <Mail className="size-3.5" />
                              Open Gmail
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              void copyText(
                                [subject ? `Subject: ${subject}` : "", body]
                                  .filter(Boolean)
                                  .join("\n\n"),
                              );
                            }}
                          >
                            <Copy className="size-3.5" />
                            Copy
                          </Button>
                          {/* Demoted to ghost now that the app can send:
                              this is the "I already sent it somewhere else"
                              button, and it advances the cadence on your word
                              alone — nothing here verifies a mail went out. */}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId === t.id}
                            onClick={() => void complete(t.id, "sent")}
                            title="Records the step as done without sending — use it after sending from Gmail"
                          >
                            {busyId === t.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Check className="size-3.5" />
                            )}
                            Mark as done
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId === t.id}
                            onClick={() => void complete(t.id, "skipped")}
                          >
                            <SkipForward className="size-3.5" />
                            Skip
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New sequence</DialogTitle>
            <DialogDescription>
              Starts with a 3-step default cadence. You&apos;ll edit every step
              next.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. QA founders outbound"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void createSeq();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={creating || !newName.trim()}
              onClick={() => void createSeq()}
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        sequences={sequences}
        tables={tables}
        enrollSeqId={enrollSeqId}
        setEnrollSeqId={setEnrollSeqId}
        enrollTableId={enrollTableId}
        setEnrollTableId={setEnrollTableId}
        enrolling={enrolling}
        onEnroll={() => void enroll()}
      />
    </div>
  );
}

function EnrollDialog({
  open,
  onOpenChange,
  sequences,
  tables,
  enrollSeqId,
  setEnrollSeqId,
  enrollTableId,
  setEnrollTableId,
  enrolling,
  onEnroll,
  hideSequencePick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sequences: Sequence[];
  tables: ResearchTable[];
  enrollSeqId: string;
  setEnrollSeqId: (v: string) => void;
  enrollTableId: string;
  setEnrollTableId: (v: string) => void;
  enrolling: boolean;
  onEnroll: () => void;
  hideSequencePick?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enroll list</DialogTitle>
          <DialogDescription>
            Every person on companies in the research list is added to this
            sequence (you&apos;ll see them under People). First due steps go to
            Today / auto email.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!hideSequencePick && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Sequence
              </label>
              <Select value={enrollSeqId} onValueChange={setEnrollSeqId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose sequence" />
                </SelectTrigger>
                <SelectContent>
                  {sequences.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Research list
            </label>
            <Select value={enrollTableId} onValueChange={setEnrollTableId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose list" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.id} value={t.slug || t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              enrolling ||
              !enrollTableId ||
              (!hideSequencePick && !enrollSeqId)
            }
            onClick={onEnroll}
          >
            {enrolling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Enroll"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
