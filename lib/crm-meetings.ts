import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity, updateCompany, type CrmCompany } from "@/lib/crm";
import { scopesIncludeCalendarReadonly } from "@/lib/outreach/google-oauth";
import {
  ensureFreshAccessToken,
  getMailboxWithSecrets,
  listMailboxes,
} from "@/lib/outreach/mailbox";

/**
 * Calendar → CRM meeting sync.
 *
 * Reads the primary Google Calendar of every connected mailbox and matches
 * event attendees to CRM accounts by e-mail domain. A match writes
 * `crm_companies.meeting_at` (next upcoming meeting, or the latest past one)
 * and moves accounts still in `lead` or `engaged` to `meeting`. Nothing is
 * ever moved backwards, and accounts past `meeting` only get the date.
 *
 * This is what makes "reply → meeting" a measured number instead of a card
 * somebody remembers to drag. Needs the calendar.readonly scope on the
 * mailbox; mailboxes connected before that scope existed are reported and
 * skipped until reconnected.
 */

const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
]);

/** Our own domains never identify a customer. */
const OWN_DOMAINS = new Set(["kodus.io", "trykodus.com"]);

/** Days of past events to scan; the future is capped at 60 days. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 60;

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean; organizer?: boolean }>;
  eventType?: string;
};

export type MeetingSyncResult = {
  mailboxes: number;
  skippedNoScope: string[];
  eventsScanned: number;
  eventsMatched: number;
  companiesTouched: number;
  statusMoved: number;
  errors: string[];
};

function domainOf(email: string | undefined): string | null {
  const m = email?.toLowerCase().match(/@([^@\s>]+)$/);
  return m ? m[1] : null;
}

function eventStart(e: GoogleEvent): string | null {
  return e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
}

function eventEnd(e: GoogleEvent): string | null {
  return e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
}

async function listPrimaryEvents(accessToken: string): Promise<GoogleEvent[]> {
  const now = Date.now();
  const timeMin = new Date(now - PAST_DAYS * 86_400_000).toISOString();
  const timeMax = new Date(now + FUTURE_DAYS * 86_400_000).toISOString();
  const out: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`calendar ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    out.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken && out.length < 1000);
  return out;
}

/** Pick the date the account should carry: next upcoming, else latest past. */
function pickMeetingAt(starts: string[]): string | null {
  if (starts.length === 0) return null;
  const now = Date.now();
  const sorted = [...starts].sort();
  const upcoming = sorted.find((s) => new Date(s).getTime() >= now);
  return upcoming ?? sorted[sorted.length - 1];
}

export async function syncCalendarMeetings(client: SupabaseClient): Promise<MeetingSyncResult> {
  const result: MeetingSyncResult = {
    mailboxes: 0,
    skippedNoScope: [],
    eventsScanned: 0,
    eventsMatched: 0,
    companiesTouched: 0,
    statusMoved: 0,
    errors: [],
  };

  const mailboxes = (await listMailboxes(client)).filter((m) => m.provider === "google_oauth");
  result.mailboxes = mailboxes.length;

  // Accounts by domain, loaded once. Archived accounts do not come back
  // because a meeting showed up; a human excluded them on purpose.
  const { data: rows, error } = await client
    .from("crm_companies")
    .select("id,name,domain,status,meeting_at")
    .is("archived_at", null)
    .not("domain", "is", null);
  if (error) throw new Error(`crm_companies: ${error.message}`);
  const byDomain = new Map<string, { id: string; name: string; status: string; meeting_at: string | null }>();
  for (const r of rows ?? []) {
    const d = String(r.domain).toLowerCase().replace(/^www\./, "");
    if (d) byDomain.set(d, r as { id: string; name: string; status: string; meeting_at: string | null });
  }

  const starts = new Map<string, string[]>(); // company id → event starts

  for (const box of mailboxes) {
    if (!scopesIncludeCalendarReadonly(box.oauthGrantedScopes)) {
      result.skippedNoScope.push(box.fromEmail);
      continue;
    }
    try {
      const secrets = await getMailboxWithSecrets(client, box.id);
      if (!secrets) continue;
      const token = await ensureFreshAccessToken(client, secrets);
      const events = await listPrimaryEvents(token);
      result.eventsScanned += events.length;

      for (const ev of events) {
        if (ev.status === "cancelled") continue;
        const start = eventStart(ev);
        if (!start) continue;
        const external = (ev.attendees ?? [])
          .map((a) => a.email?.toLowerCase() ?? "")
          .filter((e) => e && !e.endsWith("@resource.calendar.google.com"));
        const domains = new Set(
          external
            .map(domainOf)
            .filter((d): d is string => Boolean(d) && !OWN_DOMAINS.has(d!) && !FREE_MAIL.has(d!)),
        );
        if (domains.size === 0) continue;

        for (const d of domains) {
          const company = byDomain.get(d);
          if (!company) continue;
          result.eventsMatched += 1;
          const attendees = external.filter((e) => domainOf(e) === d);
          const { error: upErr } = await client.from("crm_meetings").upsert(
            {
              company_id: company.id,
              provider: "google",
              event_id: ev.id,
              calendar_email: box.fromEmail,
              title: ev.summary ?? null,
              starts_at: start,
              ends_at: eventEnd(ev),
              attendees,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "provider,event_id,company_id" },
          );
          if (upErr) {
            result.errors.push(`${company.name}: crm_meetings ${upErr.message}`);
            continue;
          }
          starts.set(company.id, [...(starts.get(company.id) ?? []), start]);
        }
      }
    } catch (err) {
      result.errors.push(`${box.fromEmail}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Write the date and, where allowed, the status.
  const byId = new Map([...byDomain.values()].map((c) => [c.id, c]));
  for (const [companyId, list] of starts) {
    const company = byId.get(companyId);
    if (!company) continue;
    const meetingAt = pickMeetingAt(list);
    const patch: Record<string, unknown> = {};
    if (meetingAt && meetingAt !== company.meeting_at) patch.meeting_at = meetingAt;
    const moves = company.status === "lead" || company.status === "engaged";
    if (Object.keys(patch).length === 0 && !moves) continue;

    if (Object.keys(patch).length > 0) {
      const { error: patchErr } = await client
        .from("crm_companies")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", companyId);
      if (patchErr) {
        result.errors.push(`${company.name}: ${patchErr.message}`);
        continue;
      }
    }
    if (moves) {
      try {
        // updateCompany logs the status_change on the timeline and touches
        // last_activity_at, same as a human move would.
        await updateCompany(client, companyId, { status: "meeting" } as Partial<CrmCompany>, "calendar-sync");
        result.statusMoved += 1;
      } catch (err) {
        result.errors.push(`${company.name}: status ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    } else if (patch.meeting_at) {
      await logActivity(client, companyId, "note", {
        summary: `Meeting on calendar: ${new Date(String(patch.meeting_at)).toISOString().slice(0, 10)}`,
        meta: { source: "calendar-sync", meeting_at: patch.meeting_at },
        actorEmail: "calendar-sync",
        touch: false,
      });
    }
    result.companiesTouched += 1;
  }

  return result;
}
