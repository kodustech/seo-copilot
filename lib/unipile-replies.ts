/**
 * Unipile LinkedIn messages → reply inbox (same Replies UI as Gmail) + sequence stop.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { markEnrollmentReplied } from "@/lib/outreach/sequences";
import {
  getUnipileUserProfile,
  identitiesFromWebhook,
  isLinkedInProviderId,
  isOutboundUnipileMessage,
  isUnipileConfigured,
  listLinkedInAccounts,
  listUnipileChatAttendees,
  listUnipileChatMessages,
  listUnipileChats,
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

  // Message id: Unipile message_id or synthetic
  const providerMessageId =
    messageId || `${chatId}:${now}:${direction}`;

  // Find existing thread by Unipile account + chat id
  const { data: existing, error: findErr } = await client
    .from("outreach_reply_threads")
    .select("id, message_count, first_inbound_at, status")
    .eq("channel", "linkedin")
    .eq("unipile_account_id", accountId)
    .eq("gmail_thread_id", chatId)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  let threadId: string | null = existing?.id
    ? (existing.id as string)
    : null;

  // Idempotent re-sync: if message already stored, only refresh match metadata.
  if (threadId) {
    const { data: existingMsg } = await client
      .from("outreach_reply_messages")
      .select("id")
      .eq("thread_id", threadId)
      .eq("gmail_message_id", providerMessageId)
      .maybeSingle();
    if (existingMsg?.id) {
      const meta: Record<string, unknown> = { updated_at: now };
      if (match.enrollmentId) meta.enrollment_id = match.enrollmentId;
      if (match.sequenceId) meta.sequence_id = match.sequenceId;
      if (match.companyName) meta.company_name = match.companyName;
      if (contactName) meta.contact_name = contactName;
      if (match.contactEmail) meta.contact_email = match.contactEmail;
      if (contactLinkedin) meta.contact_linkedin = contactLinkedin;
      if (match.matchedHow === "linkedin_profile") {
        meta.matched_how = "linkedin_profile";
      }
      await client
        .from("outreach_reply_threads")
        .update(meta)
        .eq("id", threadId);
      return { threadId, messageUpserted: false };
    }
  }

  if (threadId && existing) {
    const patch: Record<string, unknown> = {
      updated_at: now,
      subject,
      message_count: Number(existing.message_count ?? 0) + 1,
    };
    // List preview should reflect prospect reply, not our last outbound.
    if (!outbound && snippet) patch.snippet = snippet;
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
 * Expand webhook identities with LinkedIn vanity slugs when Unipile only
 * sends ACoAA provider ids (common on profile_url).
 */
export async function expandLinkedInIdentities(
  accountId: string | undefined,
  identities: string[],
): Promise<string[]> {
  const out = new Set(identities.map((i) => i.toLowerCase()));
  if (!accountId || !isUnipileConfigured()) return [...out];

  for (const id of identities) {
    if (!isLinkedInProviderId(id)) continue;
    const profile = await getUnipileUserProfile({
      accountId,
      identifier: id,
    });
    if (profile?.publicIdentifier) {
      const slug = normalizeLinkedInIdentity(profile.publicIdentifier);
      if (slug) out.add(slug);
    }
    if (profile?.profileUrl) {
      const fromUrl = normalizeLinkedInIdentity(profile.profileUrl);
      if (fromUrl) out.add(fromUrl);
    }
  }
  return [...out];
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
  const rawIdentities = identitiesFromWebhook(payload);
  const identities = await expandLinkedInIdentities(
    payload.account_id,
    rawIdentities,
  );

  const enrollments = await findEnrollmentsByLinkedInIdentities(
    client,
    identities,
  );
  // Any sequence enrollment (incl. cancelled) is enough to treat as campaign reply.
  // Prefer live statuses for stop/CRM side-effects.
  const stoppable = enrollments.filter(
    (e) =>
      e.status === "active" ||
      e.status === "paused" ||
      e.status === "completed" ||
      e.status === "replied",
  );
  const primary =
    stoppable.find((e) => e.status === "active") ??
    stoppable[0] ??
    enrollments[0] ??
    null;

  // Replies is sequence inbox — never create threads for personal / spam DMs.
  // Continue writing only when already linked (same Unipile chat) or enrollment match.
  let existingThreadId: string | null = null;
  if (payload.account_id && payload.chat_id) {
    const { data: existing } = await client
      .from("outreach_reply_threads")
      .select("id")
      .eq("channel", "linkedin")
      .eq("unipile_account_id", payload.account_id)
      .eq("gmail_thread_id", payload.chat_id)
      .maybeSingle();
    existingThreadId = (existing?.id as string | undefined) ?? null;
  }

  if (!primary && !existingThreadId) {
    return {
      handled: true,
      outbound,
      threadId: null,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: `ignored non-sequence linkedin dm (${identities.join(",") || "no ids"})`,
    };
  }

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

  // Only stop sequence / CRM on inbound + matched live enrollments
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

  if (stoppable.length === 0) {
    return {
      handled: true,
      outbound: false,
      threadId,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: primary
        ? "stored linkedin reply (enrollment not stoppable)"
        : "appended to existing sequence thread",
    };
  }

  const matchedEnrollmentIds: string[] = [];
  const crmCompanyIds: string[] = [];

  for (const enr of stoppable) {
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

export type LinkedInInboxSyncResult = {
  ok: boolean;
  mode: "unipile_pull";
  accounts: number;
  chatsScanned: number;
  threadsTouched: number;
  messagesUpserted: number;
  enrollmentsMarkedReplied: number;
  error?: string;
};

/**
 * Pull recent LinkedIn chats from Unipile into Replies.
 * Webhooks only fire for live messages after account connect — this backfills
 * history (e.g. prospect replied before Unipile was linked).
 *
 * Only sequence enrollments: personal / spam DMs are skipped. Requires at
 * least one inbound message + matching contact_linkedin on an enrollment.
 */
export async function syncUnipileLinkedInInbox(
  client: SupabaseClient,
  opts?: { chatLimit?: number; messagesPerChat?: number },
): Promise<LinkedInInboxSyncResult> {
  if (!isUnipileConfigured()) {
    return {
      ok: true,
      mode: "unipile_pull",
      accounts: 0,
      chatsScanned: 0,
      threadsTouched: 0,
      messagesUpserted: 0,
      enrollmentsMarkedReplied: 0,
      error: "Unipile not configured",
    };
  }

  const chatLimit = Math.min(80, Math.max(5, opts?.chatLimit ?? 40));
  const messagesPerChat = Math.min(40, Math.max(5, opts?.messagesPerChat ?? 20));

  let accounts = 0;
  let chatsScanned = 0;
  let threadsTouched = 0;
  let messagesUpserted = 0;
  let enrollmentsMarkedReplied = 0;
  const threadIds = new Set<string>();
  const enrollmentsStopped = new Set<string>();

  try {
    const liAccounts = await listLinkedInAccounts();
    accounts = liAccounts.length;

    for (const account of liAccounts) {
      const { items: chats } = await listUnipileChats({
        accountId: account.id,
        limit: chatLimit,
      });

      for (const chat of chats) {
        chatsScanned += 1;
        let messages: Awaited<ReturnType<typeof listUnipileChatMessages>>;
        try {
          messages = await listUnipileChatMessages({
            chatId: chat.id,
            limit: messagesPerChat,
          });
        } catch (err) {
          console.warn("[unipile] list messages failed", chat.id, err);
          continue;
        }

        const inbound = messages.filter((m) => !m.isSender);
        if (inbound.length === 0) continue;

        // Oldest first so first_inbound / snippets settle sensibly
        const ordered = [...messages].sort((a, b) => {
          const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
          const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
          return ta - tb;
        });

        let attendees: Awaited<ReturnType<typeof listUnipileChatAttendees>> =
          [];
        try {
          attendees = await listUnipileChatAttendees({
            accountId: account.id,
            chatId: chat.id,
          });
        } catch {
          /* optional */
        }

        const other =
          attendees.find((a) => !a.isSelf) ??
          (chat.attendeeProviderId
            ? {
                id: "",
                name: null,
                providerId: chat.attendeeProviderId,
                profileUrl: null,
                isSelf: false,
              }
            : null);

        const identities: string[] = [];
        if (other?.providerId) identities.push(other.providerId);
        if (other?.profileUrl) {
          const n = normalizeLinkedInIdentity(other.profileUrl);
          if (n) identities.push(n);
        }
        const expanded = await expandLinkedInIdentities(
          account.id,
          identities,
        );

        const enrollments = await findEnrollmentsByLinkedInIdentities(
          client,
          expanded,
        );
        if (enrollments.length === 0) continue;

        const stoppable = enrollments.filter(
          (e) =>
            e.status === "active" ||
            e.status === "paused" ||
            e.status === "completed" ||
            e.status === "replied",
        );
        const primary =
          stoppable.find((e) => e.status === "active") ??
          stoppable[0] ??
          enrollments[0] ??
          null;
        if (!primary) continue;

        // Prefer vanity profile URL for display / match metadata
        let contactLinkedin: string | null =
          primary.contactLinkedin || other?.profileUrl || null;
        const vanity = expanded.find((i) => !isLinkedInProviderId(i));
        if (vanity && !primary.contactLinkedin) {
          contactLinkedin = `https://www.linkedin.com/in/${vanity}`;
        }

        let contactName =
          primary.contactName || other?.name || null;
        if (!contactName && other?.providerId) {
          const prof = await getUnipileUserProfile({
            accountId: account.id,
            identifier: other.providerId,
          });
          if (prof) {
            contactName =
              [prof.firstName, prof.lastName]
                .filter((p) => p && p !== "undefined")
                .join(" ") || null;
            if (prof.profileUrl && !contactLinkedin) {
              contactLinkedin = prof.profileUrl;
            }
          }
        }

        const ourProviderId = account.providerUserId;

        for (const msg of ordered) {
          const payload: UnipileWebhookPayload = {
            event: "message_received",
            account_id: account.id,
            account_type: "LINKEDIN",
            account_info: {
              type: "LINKEDIN",
              user_id: ourProviderId || undefined,
            },
            chat_id: chat.id,
            message_id: msg.id,
            message: msg.text ?? undefined,
            timestamp: msg.timestamp ?? undefined,
            sender: msg.isSender
              ? {
                  attendee_provider_id:
                    ourProviderId || msg.senderProviderId || undefined,
                  attendee_name: "me",
                }
              : {
                  attendee_provider_id:
                    msg.senderProviderId || other?.providerId || undefined,
                  attendee_name: contactName || undefined,
                  attendee_profile_url: contactLinkedin || undefined,
                },
            attendees: other
              ? [
                  {
                    attendee_provider_id: other.providerId || undefined,
                    attendee_name: contactName || other.name || undefined,
                    attendee_profile_url: contactLinkedin || undefined,
                  },
                ]
              : undefined,
          };

          try {
            const upserted = await upsertLinkedInReplyThread(client, payload, {
              enrollmentId: primary.id,
              sequenceId: primary.sequenceId,
              contactName: primary.contactName ?? contactName,
              contactEmail: primary.contactEmail,
              contactLinkedin: primary.contactLinkedin ?? contactLinkedin,
              companyName: primary.companyName,
              matchedHow: "linkedin_profile",
            });
            threadIds.add(upserted.threadId);
            if (upserted.messageUpserted) messagesUpserted += 1;
          } catch (err) {
            console.warn("[unipile] sync upsert failed", chat.id, msg.id, err);
          }
        }

        // Stop sequences for matched enrollments (inbound present)
        for (const enr of stoppable) {
          if (enrollmentsStopped.has(enr.id)) continue;
          if (enr.status === "replied") {
            enrollmentsStopped.add(enr.id);
            continue;
          }
          try {
            await markEnrollmentReplied(client, enr.id, {
              source: "unipile_linkedin_sync",
            });
            enrollmentsStopped.add(enr.id);
            enrollmentsMarkedReplied += 1;
          } catch (err) {
            console.warn("[unipile] mark replied failed", enr.id, err);
          }
        }
      }
    }

    threadsTouched = threadIds.size;
    return {
      ok: true,
      mode: "unipile_pull",
      accounts,
      chatsScanned,
      threadsTouched,
      messagesUpserted,
      enrollmentsMarkedReplied,
    };
  } catch (err) {
    return {
      ok: false,
      mode: "unipile_pull",
      accounts,
      chatsScanned,
      threadsTouched,
      messagesUpserted,
      enrollmentsMarkedReplied,
      error: err instanceof Error ? err.message : "LinkedIn sync failed",
    };
  }
}
