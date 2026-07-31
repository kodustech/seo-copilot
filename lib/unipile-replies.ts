/**
 * Unipile LinkedIn messages → reply inbox (same Replies UI as Gmail) + sequence stop.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { markEnrollmentReplied } from "@/lib/outreach/sequences";
import {
  identitiesFromWebhook,
  isOutboundUnipileMessage,
  normalizeLinkedInIdentity,
  type UnipileWebhookPayload,
} from "@/lib/unipile";

export type UnipileReplyMatchResult = {
  handled: boolean;
  outbound: boolean;
  threadId: string | null;
  matchedEnrollmentIds: string[];
  crmCompanyIds: string[];
  reason?: string;
};

function enrollmentLinkedInKeys(
  contactLinkedin: string | null | undefined,
): string[] {
  const n = normalizeLinkedInIdentity(contactLinkedin);
  return n ? [n] : [];
}

export async function findEnrollmentsByLinkedInIdentities(
  client: SupabaseClient,
  identities: string[],
): Promise<
  Array<{
    id: string;
    status: string;
    sequenceId: string | null;
    contactLinkedin: string | null;
    contactName: string | null;
    contactEmail: string | null;
    companyName: string;
  }>
> {
  if (identities.length === 0) return [];

  const identitySet = new Set(identities.map((i) => i.toLowerCase()));

  const { data, error } = await client
    .from("outreach_enrollments")
    .select(
      "id, status, sequence_id, contact_linkedin, contact_name, contact_email, company_name",
    )
    .not("contact_linkedin", "is", null)
    .order("updated_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const hits: Array<{
    id: string;
    status: string;
    sequenceId: string | null;
    contactLinkedin: string | null;
    contactName: string | null;
    contactEmail: string | null;
    companyName: string;
  }> = [];

  for (const row of data ?? []) {
    const keys = enrollmentLinkedInKeys(row.contact_linkedin as string | null);
    if (keys.some((k) => identitySet.has(k))) {
      hits.push({
        id: row.id as string,
        status: row.status as string,
        sequenceId: (row.sequence_id as string | null) ?? null,
        contactLinkedin: (row.contact_linkedin as string | null) ?? null,
        contactName: (row.contact_name as string | null) ?? null,
        contactEmail: (row.contact_email as string | null) ?? null,
        companyName: (row.company_name as string) || "",
      });
    }
  }
  return hits;
}

/**
 * Upsert LinkedIn DM into outreach_reply_threads / messages so it appears in Replies.
 * Uses gmail_thread_id column to store Unipile chat_id (provider thread key).
 */
export async function upsertLinkedInReplyThread(
  client: SupabaseClient,
  payload: UnipileWebhookPayload,
  match: {
    enrollmentId: string | null;
    sequenceId: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactLinkedin: string | null;
    companyName: string | null;
    matchedHow: "linkedin_profile" | "unmatched";
  },
): Promise<{ threadId: string; messageUpserted: boolean }> {
  const accountId = payload.account_id;
  const chatId = payload.chat_id;
  const messageId = payload.message_id;
  if (!accountId || !chatId) {
    throw new Error("Unipile payload missing account_id or chat_id");
  }

  const outbound = isOutboundUnipileMessage(payload);
  const direction = outbound ? "outbound_ours" : "inbound";
  const now = payload.timestamp || new Date().toISOString();
  const bodyText = payload.message?.trim() || null;
  const snippet = bodyText
    ? bodyText.length > 180
      ? `${bodyText.slice(0, 180)}…`
      : bodyText
    : null;
  const subject = match.companyName
    ? `LinkedIn · ${match.companyName}`
    : match.contactName
      ? `LinkedIn · ${match.contactName}`
      : "LinkedIn message";

  const contactName =
    match.contactName ||
    (!outbound ? payload.sender?.attendee_name ?? null : null);
  const contactLinkedin =
    match.contactLinkedin ||
    (!outbound
      ? payload.sender?.attendee_profile_url ?? null
      : payload.attendees?.find(
          (a) =>
            a.attendee_provider_id !== payload.account_info?.user_id,
        )?.attendee_profile_url ?? null);

  // Find existing thread by Unipile account + chat id
  const { data: existing, error: findErr } = await client
    .from("outreach_reply_threads")
    .select("id, message_count, first_inbound_at, status")
    .eq("channel", "linkedin")
    .eq("unipile_account_id", accountId)
    .eq("gmail_thread_id", chatId)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  let threadId: string;
  if (existing?.id) {
    threadId = existing.id as string;
    const patch: Record<string, unknown> = {
      updated_at: now,
      snippet,
      subject,
      message_count: Number(existing.message_count ?? 0) + 1,
    };
    if (!outbound) {
      patch.last_inbound_at = now;
      if (!existing.first_inbound_at) patch.first_inbound_at = now;
      // Re-open if was done
      if (existing.status === "done") patch.status = "new";
      else if (existing.status === "open") {
        /* keep */
      } else if (existing.status !== "new") patch.status = "new";
    }
    if (match.enrollmentId) patch.enrollment_id = match.enrollmentId;
    if (match.sequenceId) patch.sequence_id = match.sequenceId;
    if (match.companyName) patch.company_name = match.companyName;
    if (contactName) patch.contact_name = contactName;
    if (match.contactEmail) patch.contact_email = match.contactEmail;
    if (contactLinkedin) patch.contact_linkedin = contactLinkedin;
    if (match.matchedHow === "linkedin_profile") {
      patch.matched_how = "linkedin_profile";
    }

    const { error: uErr } = await client
      .from("outreach_reply_threads")
      .update(patch)
      .eq("id", threadId);
    if (uErr) throw new Error(uErr.message);
  } else {
    const { data: inserted, error: iErr } = await client
      .from("outreach_reply_threads")
      .insert({
        channel: "linkedin",
        mailbox_id: null,
        unipile_account_id: accountId,
        gmail_thread_id: chatId,
        enrollment_id: match.enrollmentId,
        sequence_id: match.sequenceId,
        contact_email: match.contactEmail,
        contact_name: contactName,
        contact_linkedin: contactLinkedin,
        company_name: match.companyName,
        subject,
        snippet,
        status: outbound ? "open" : "new",
        matched_how: match.matchedHow,
        message_count: 1,
        first_inbound_at: outbound ? null : now,
        last_inbound_at: outbound ? null : now,
        updated_at: now,
      })
      .select("id")
      .single();
    if (iErr) throw new Error(iErr.message);
    threadId = inserted.id as string;
  }

  // Message id: Unipile message_id or synthetic
  const providerMessageId =
    messageId || `${chatId}:${now}:${direction}`;

  const { error: msgErr } = await client.from("outreach_reply_messages").upsert(
    {
      thread_id: threadId,
      gmail_message_id: providerMessageId,
      direction,
      from_email: outbound
        ? "me@linkedin"
        : payload.sender?.attendee_name ||
          payload.sender?.attendee_provider_id ||
          null,
      to_emails: [],
      subject,
      body_text: bodyText,
      body_html: null,
      snippet,
      rfc_message_id: null,
      in_reply_to: null,
      internal_date: now,
    },
    { onConflict: "thread_id,gmail_message_id" },
  );
  if (msgErr) throw new Error(msgErr.message);

  return { threadId, messageUpserted: true };
}

/**
 * Process Unipile message_received: write to Replies inbox + mark enrollment replied.
 */
export async function handleUnipileMessageReceived(
  client: SupabaseClient,
  payload: UnipileWebhookPayload,
): Promise<UnipileReplyMatchResult> {
  const accountType = (payload.account_type ?? payload.account_info?.type ?? "")
    .toString()
    .toUpperCase();
  if (accountType && !accountType.includes("LINKEDIN")) {
    return {
      handled: false,
      outbound: false,
      threadId: null,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: `ignored account_type=${accountType}`,
    };
  }

  if (payload.event && payload.event !== "message_received") {
    return {
      handled: false,
      outbound: false,
      threadId: null,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: `ignored event=${payload.event}`,
    };
  }

  const outbound = isOutboundUnipileMessage(payload);
  const identities = identitiesFromWebhook(payload);

  const enrollments = await findEnrollmentsByLinkedInIdentities(
    client,
    identities,
  );
  const candidates = enrollments.filter(
    (e) =>
      e.status === "active" ||
      e.status === "paused" ||
      e.status === "completed" ||
      e.status === "replied",
  );

  // Prefer active first for matching metadata
  const primary =
    candidates.find((e) => e.status === "active") ?? candidates[0] ?? null;

  let threadId: string | null = null;
  try {
    const upserted = await upsertLinkedInReplyThread(client, payload, {
      enrollmentId: primary?.id ?? null,
      sequenceId: primary?.sequenceId ?? null,
      contactName: primary?.contactName ?? null,
      contactEmail: primary?.contactEmail ?? null,
      contactLinkedin: primary?.contactLinkedin ?? null,
      companyName: primary?.companyName ?? null,
      matchedHow: primary ? "linkedin_profile" : "unmatched",
    });
    threadId = upserted.threadId;
  } catch (err) {
    console.error("[unipile] upsert reply thread failed:", err);
    return {
      handled: false,
      outbound,
      threadId: null,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason:
        err instanceof Error ? err.message : "failed to upsert reply thread",
    };
  }

  // Only stop sequence / CRM on inbound
  if (outbound) {
    return {
      handled: true,
      outbound: true,
      threadId,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: "stored outbound linkedin message in inbox",
    };
  }

  if (candidates.length === 0) {
    return {
      handled: true,
      outbound: false,
      threadId,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: `stored unmatched linkedin reply (${identities.join(",") || "no ids"})`,
    };
  }

  const matchedEnrollmentIds: string[] = [];
  const crmCompanyIds: string[] = [];

  for (const enr of candidates) {
    const result = await markEnrollmentReplied(client, enr.id, {
      source: "unipile_linkedin",
    });
    matchedEnrollmentIds.push(enr.id);
    if (result.crm?.companyId) crmCompanyIds.push(result.crm.companyId);
  }

  return {
    handled: true,
    outbound: false,
    threadId,
    matchedEnrollmentIds,
    crmCompanyIds: [...new Set(crmCompanyIds)],
  };
}
