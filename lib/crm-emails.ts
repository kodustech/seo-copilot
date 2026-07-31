/**
 * Email history for a CRM company — reuses sequence outbound + Gmail reply inbox.
 * Match by domain, contact emails, and exact company name on enrollments/threads.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getCompany, listContacts, normalizeDomain } from "@/lib/crm";

export type CompanyEmailDirection = "outbound" | "inbound";

export type CompanyEmailItem = {
  id: string;
  direction: CompanyEmailDirection;
  at: string;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  /** Short preview for list */
  snippet: string | null;
  /** Full plain body when available */
  bodyText: string | null;
  source: "sequence" | "gmail_sync";
  sequenceName: string | null;
  contactEmail: string | null;
  contactName: string | null;
  status: string | null;
  threadId: string | null;
  gmailThreadId: string | null;
};

export type CompanyEmailTimeline = {
  companyId: string;
  match: {
    domain: string | null;
    contactEmails: string[];
    companyName: string;
  };
  items: CompanyEmailItem[];
  counts: {
    total: number;
    outbound: number;
    inbound: number;
    threads: number;
  };
};

function emailDomain(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  return email.split("@").pop()?.trim().toLowerCase() || null;
}

function preview(text: string | null | undefined, max = 220): string | null {
  if (!text) return null;
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Build a chronological email timeline for a CRM account.
 */
export async function getCompanyEmailTimeline(
  client: SupabaseClient,
  companyId: string,
): Promise<CompanyEmailTimeline | null> {
  const company = await getCompany(client, companyId);
  if (!company) return null;

  const contacts = await listContacts(client, companyId);
  const domain = normalizeDomain(company.domain);
  const contactEmails = [
    ...new Set(
      contacts
        .map((c) => c.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e)),
    ),
  ];
  const companyName = company.name.trim();

  // ── Enrollments that belong to this account ──────────────────────────
  const enrollmentIds = new Set<string>();
  const enrMeta = new Map<
    string,
    {
      contactEmail: string | null;
      contactName: string | null;
      sequenceId: string | null;
      companyName: string | null;
    }
  >();

  // By domain
  if (domain) {
    const { data, error } = await client
      .from("outreach_enrollments")
      .select("id, contact_email, contact_name, sequence_id, company_name, domain")
      .ilike("domain", domain);
    if (error) throw new Error(error.message);
    for (const e of data ?? []) {
      enrollmentIds.add(e.id as string);
      enrMeta.set(e.id as string, {
        contactEmail: (e.contact_email as string | null) ?? null,
        contactName: (e.contact_name as string | null) ?? null,
        sequenceId: (e.sequence_id as string | null) ?? null,
        companyName: (e.company_name as string | null) ?? null,
      });
    }
  }

  // By contact emails
  for (let i = 0; i < contactEmails.length; i += 40) {
    const slice = contactEmails.slice(i, i + 40);
    if (!slice.length) break;
    const { data, error } = await client
      .from("outreach_enrollments")
      .select("id, contact_email, contact_name, sequence_id, company_name, domain")
      .in("contact_email", slice);
    if (error) throw new Error(error.message);
    for (const e of data ?? []) {
      enrollmentIds.add(e.id as string);
      enrMeta.set(e.id as string, {
        contactEmail: (e.contact_email as string | null) ?? null,
        contactName: (e.contact_name as string | null) ?? null,
        sequenceId: (e.sequence_id as string | null) ?? null,
        companyName: (e.company_name as string | null) ?? null,
      });
    }
  }

  // By exact company name (fallback when domain missing)
  if (companyName) {
    const { data, error } = await client
      .from("outreach_enrollments")
      .select("id, contact_email, contact_name, sequence_id, company_name, domain")
      .ilike("company_name", companyName);
    if (error) throw new Error(error.message);
    for (const e of data ?? []) {
      // If company has a domain, only accept enrollment with same domain or null domain
      const enrDom = normalizeDomain(e.domain as string | null);
      if (domain && enrDom && enrDom !== domain) continue;
      enrollmentIds.add(e.id as string);
      enrMeta.set(e.id as string, {
        contactEmail: (e.contact_email as string | null) ?? null,
        contactName: (e.contact_name as string | null) ?? null,
        sequenceId: (e.sequence_id as string | null) ?? null,
        companyName: (e.company_name as string | null) ?? null,
      });
    }
  }

  // Contact emails whose domain matches company domain (even if not in CRM contacts)
  // already covered by enrollment domain match.

  const enrIds = [...enrollmentIds];
  const sequenceIds = [
    ...new Set(
      [...enrMeta.values()]
        .map((e) => e.sequenceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const seqName = new Map<string, string>();
  if (sequenceIds.length > 0) {
    const { data: seqs } = await client
      .from("outreach_sequences")
      .select("id, name")
      .in("id", sequenceIds);
    for (const s of seqs ?? []) {
      seqName.set(s.id as string, (s.name as string) || "Sequence");
    }
  }

  // ── Outbound sequence emails ─────────────────────────────────────────
  const outboundByGmailThread = new Set<string>();
  const outboundByRfc = new Set<string>();
  const items: CompanyEmailItem[] = [];

  for (let i = 0; i < enrIds.length; i += 40) {
    const slice = enrIds.slice(i, i + 40);
    if (!slice.length) break;
    const { data: tasks, error } = await client
      .from("outreach_send_tasks")
      .select(
        "id, enrollment_id, status, sent_at, rendered_subject, rendered_body, meta, error, provider_message_id",
      )
      .eq("channel", "email")
      .in("status", ["sent", "failed", "skipped"])
      .in("enrollment_id", slice)
      .order("sent_at", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);

    for (const t of tasks ?? []) {
      const meta = (t.meta ?? {}) as Record<string, unknown>;
      const gmailThreadId =
        typeof meta.gmail_thread_id === "string" ? meta.gmail_thread_id : null;
      const rfc =
        typeof meta.rfc_message_id === "string" ? meta.rfc_message_id : null;
      if (gmailThreadId) outboundByGmailThread.add(gmailThreadId);
      if (rfc) outboundByRfc.add(rfc.toLowerCase());

      const enr = enrMeta.get(t.enrollment_id as string);
      const at =
        (t.sent_at as string | null) ||
        (typeof meta.sent_at === "string" ? meta.sent_at : null) ||
        new Date(0).toISOString();
      const body = (t.rendered_body as string | null) ?? null;
      items.push({
        id: `task:${t.id}`,
        direction: "outbound",
        at,
        fromEmail:
          typeof meta.from === "string"
            ? meta.from
            : typeof meta.sent_by_email === "string"
              ? meta.sent_by_email
              : null,
        toEmail: enr?.contactEmail ?? null,
        subject: (t.rendered_subject as string | null) ??
          (typeof meta.subject === "string" ? meta.subject : null),
        snippet: preview(body),
        bodyText: body,
        source: "sequence",
        sequenceName: enr?.sequenceId
          ? seqName.get(enr.sequenceId) ?? null
          : null,
        contactEmail: enr?.contactEmail ?? null,
        contactName: enr?.contactName ?? null,
        status: (t.status as string) ?? null,
        threadId: null,
        gmailThreadId,
      });
    }
  }

  // ── Reply inbox threads (Gmail sync) ─────────────────────────────────
  const threadIds: string[] = [];
  const threadById = new Map<
    string,
    {
      contactEmail: string | null;
      contactName: string | null;
      subject: string | null;
      gmailThreadId: string;
      sequenceId: string | null;
    }
  >();

  // Match threads by contact email
  for (let i = 0; i < contactEmails.length; i += 40) {
    const slice = contactEmails.slice(i, i + 40);
    if (!slice.length) break;
    const { data, error } = await client
      .from("outreach_reply_threads")
      .select(
        "id, contact_email, contact_name, company_name, subject, gmail_thread_id, sequence_id",
      )
      .in("contact_email", slice);
    if (error) throw new Error(error.message);
    for (const th of data ?? []) {
      threadIds.push(th.id as string);
      threadById.set(th.id as string, {
        contactEmail: (th.contact_email as string | null) ?? null,
        contactName: (th.contact_name as string | null) ?? null,
        subject: (th.subject as string | null) ?? null,
        gmailThreadId: th.gmail_thread_id as string,
        sequenceId: (th.sequence_id as string | null) ?? null,
      });
    }
  }

  // Match by company name on thread
  if (companyName) {
    const { data, error } = await client
      .from("outreach_reply_threads")
      .select(
        "id, contact_email, contact_name, company_name, subject, gmail_thread_id, sequence_id",
      )
      .ilike("company_name", companyName);
    if (error) throw new Error(error.message);
    for (const th of data ?? []) {
      const contactDom = emailDomain(th.contact_email as string | null);
      if (domain && contactDom && contactDom !== domain) continue;
      if (!threadById.has(th.id as string)) {
        threadIds.push(th.id as string);
        threadById.set(th.id as string, {
          contactEmail: (th.contact_email as string | null) ?? null,
          contactName: (th.contact_name as string | null) ?? null,
          subject: (th.subject as string | null) ?? null,
          gmailThreadId: th.gmail_thread_id as string,
          sequenceId: (th.sequence_id as string | null) ?? null,
        });
      }
    }
  }

  // Threads already linked to matched enrollments
  for (let i = 0; i < enrIds.length; i += 40) {
    const slice = enrIds.slice(i, i + 40);
    if (!slice.length) break;
    const { data, error } = await client
      .from("outreach_reply_threads")
      .select(
        "id, contact_email, contact_name, company_name, subject, gmail_thread_id, sequence_id, enrollment_id",
      )
      .in("enrollment_id", slice);
    if (error) throw new Error(error.message);
    for (const th of data ?? []) {
      if (!threadById.has(th.id as string)) {
        threadIds.push(th.id as string);
        threadById.set(th.id as string, {
          contactEmail: (th.contact_email as string | null) ?? null,
          contactName: (th.contact_name as string | null) ?? null,
          subject: (th.subject as string | null) ?? null,
          gmailThreadId: th.gmail_thread_id as string,
          sequenceId: (th.sequence_id as string | null) ?? null,
        });
      }
    }
  }

  // Load messages for matched threads
  const uniqueThreadIds = [...new Set(threadIds)];
  for (let i = 0; i < uniqueThreadIds.length; i += 30) {
    const slice = uniqueThreadIds.slice(i, i + 30);
    if (!slice.length) break;
    const { data: msgs, error } = await client
      .from("outreach_reply_messages")
      .select(
        "id, thread_id, direction, from_email, to_emails, subject, body_text, snippet, rfc_message_id, internal_date, created_at",
      )
      .in("thread_id", slice)
      .order("internal_date", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);

    for (const m of msgs ?? []) {
      const th = threadById.get(m.thread_id as string);
      const direction =
        (m.direction as string) === "outbound_ours" ? "outbound" : "inbound";
      const rfc = (m.rfc_message_id as string | null)?.toLowerCase() ?? null;
      const gmailThreadId = th?.gmailThreadId ?? null;

      // Prefer Gmail-synced copy over sequence task when same message
      if (direction === "outbound") {
        if (rfc && outboundByRfc.has(rfc)) {
          // Drop sequence duplicate
          const idx = items.findIndex(
            (it) =>
              it.source === "sequence" &&
              it.gmailThreadId &&
              gmailThreadId &&
              it.gmailThreadId === gmailThreadId &&
              it.subject ===
                ((m.subject as string | null) ?? th?.subject ?? null),
          );
          if (idx >= 0) items.splice(idx, 1);
        } else if (gmailThreadId && outboundByGmailThread.has(gmailThreadId)) {
          // keep gmail message; remove one sequence outbound on same thread+time proximity later
        }
      }

      const body = (m.body_text as string | null) ?? null;
      const snippet =
        (m.snippet as string | null) ?? preview(body);
      const toList = Array.isArray(m.to_emails)
        ? (m.to_emails as string[])
        : [];
      const at =
        (m.internal_date as string | null) ||
        (m.created_at as string) ||
        new Date(0).toISOString();

      items.push({
        id: `msg:${m.id}`,
        direction,
        at,
        fromEmail: (m.from_email as string | null) ?? null,
        toEmail: toList[0] ?? th?.contactEmail ?? null,
        subject:
          (m.subject as string | null) ?? th?.subject ?? null,
        snippet,
        bodyText: body,
        source: "gmail_sync",
        sequenceName: th?.sequenceId
          ? seqName.get(th.sequenceId) ?? null
          : null,
        contactEmail: th?.contactEmail ?? null,
        contactName: th?.contactName ?? null,
        status: null,
        threadId: m.thread_id as string,
        gmailThreadId,
      });
    }
  }

  // Dedup sequence vs gmail outbound on same gmail_thread_id: prefer gmail_sync
  const gmailOutboundThreads = new Set(
    items
      .filter((i) => i.source === "gmail_sync" && i.direction === "outbound")
      .map((i) => i.gmailThreadId)
      .filter(Boolean) as string[],
  );
  const deduped = items.filter((i) => {
    if (
      i.source === "sequence" &&
      i.direction === "outbound" &&
      i.gmailThreadId &&
      gmailOutboundThreads.has(i.gmailThreadId)
    ) {
      return false;
    }
    return true;
  });

  deduped.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const outbound = deduped.filter((i) => i.direction === "outbound").length;
  const inbound = deduped.filter((i) => i.direction === "inbound").length;

  return {
    companyId,
    match: {
      domain,
      contactEmails,
      companyName,
    },
    items: deduped,
    counts: {
      total: deduped.length,
      outbound,
      inbound,
      threads: uniqueThreadIds.length,
    },
  };
}
