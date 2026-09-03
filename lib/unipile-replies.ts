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
    createdAt: string | null;
  }>
> {
  if (identities.length === 0) return [];

  const identitySet = new Set(identities.map((i) => i.toLowerCase()));

  const { data, error } = await client
    .from("outreach_enrollments")
    .select(
      "id, status, sequence_id, contact_linkedin, contact_name, contact_email, company_name, created_at",
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
    createdAt: string | null;
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
        createdAt: (row.created_at as string | null) ?? null,
      });
    }
  }
  return hits;
}

type EnrollmentHit = Awaited<ReturnType<typeof findEnrollmentsByLinkedInIdentities>>[number];

/**
 * A LinkedIn message we sent by hand (the step failed on Unipile, or the
 * operator typed it in LinkedIn) leaves no send task, so the enrollment never
 * counts as contacted and the account shows "Never". The chat has our
 * outbound messages with timestamps: mark the enrollment's pending LinkedIn
 * tasks as sent, in order, one per message after the enrollment started, and
 * write the send onto the CRM account like a machine send would.
 */
async function reconcileManualLinkedInSends(
  client: SupabaseClient,
  enrollment: EnrollmentHit,
  outboundTimestamps: string[],
  companyId: string | null,
): Promise<number> {
  const startedAt = enrollment.createdAt ? Date.parse(enrollment.createdAt) : 0;
  const ours = outboundTimestamps
    .filter((t) => Date.parse(t) >= startedAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  if (ours.length === 0) return 0;
  const { data: tasks } = await client
    .from("outreach_send_tasks")
    .select("id,status,scheduled_for")
    .eq("enrollment_id", enrollment.id)
    .eq("channel", "linkedin")
    .neq("status", "sent")
    .neq("status", "cancelled")
    .order("scheduled_for", { ascending: true });
  const pending = tasks ?? [];
  // Messages already accounted for: a sent LinkedIn task whose sent_at sits
  // within a few minutes of the chat message (machine sends land seconds
  // apart; a reconciled manual send carries the exact timestamp). Pairing
  // by time keeps a manual message that came before a machine step from
  // being mistaken for it, and makes a second pass a no-op.
  const { data: sentTasks } = await client
    .from("outreach_send_tasks")
    .select("sent_at")
    .eq("enrollment_id", enrollment.id)
    .eq("channel", "linkedin")
    .eq("status", "sent")
    .not("sent_at", "is", null);
  const unclaimed = (sentTasks ?? []).map((t) => Date.parse(String(t.sent_at))).filter((n) => Number.isFinite(n));
  const TOLERANCE_MS = 10 * 60 * 1000;
  const toRecord = ours.filter((ts) => {
    const t = Date.parse(ts);
    let best = -1;
    for (let i = 0; i < unclaimed.length; i++) {
      if (Math.abs(unclaimed[i] - t) <= TOLERANCE_MS && (best < 0 || Math.abs(unclaimed[i] - t) < Math.abs(unclaimed[best] - t))) best = i;
    }
    if (best < 0) return true;
    unclaimed.splice(best, 1);
    return false;
  });
  if (toRecord.length === 0) return 0;

  // Steps to hang created tasks on when the enrollment has none left
  // (paused early, or the task rows were never generated).
  let linkedinSteps: Array<{ id: string; position: number }> = [];
  if (pending.length < toRecord.length && enrollment.sequenceId) {
    const { data: steps } = await client
      .from("outreach_sequence_steps")
      .select("id,position")
      .eq("sequence_id", enrollment.sequenceId)
      .eq("channel", "linkedin")
      .order("position", { ascending: true });
    linkedinSteps = (steps ?? []) as Array<{ id: string; position: number }>;
  }

  let marked = 0;
  for (let i = 0; i < toRecord.length; i++) {
    const sentAt = toRecord[i];
    if (i < pending.length) {
      const { error } = await client
        .from("outreach_send_tasks")
        .update({
          status: "sent",
          sent_at: sentAt,
          provider: "linkedin_manual",
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending[i].id as string);
      if (error) continue;
    } else {
      const step = linkedinSteps[Math.min(i, linkedinSteps.length - 1)];
      if (!step) break;
      const { error } = await client.from("outreach_send_tasks").insert({
        enrollment_id: enrollment.id,
        step_id: step.id,
        channel: "linkedin",
        mode: "semi",
        status: "sent",
        scheduled_for: sentAt,
        sent_at: sentAt,
        provider: "linkedin_manual",
        meta: { reconciled_from_chat: true },
      });
      if (error) continue;
    }
    marked += 1;
    if (companyId) {
      try {
        const { logActivity } = await import("@/lib/crm");
        await logActivity(client, companyId, "outreach_sent", {
          summary: `LinkedIn sent to ${enrollment.contactName ?? "contact"} (manual, from chat)`,
          meta: { channel: "linkedin", enrollment_id: enrollment.id, sequence_id: enrollment.sequenceId, reconciled_from_chat: true },
          actorEmail: null,
          touch: false,
        });
        await client.rpc("bump_outreach_counters", { p_company_id: companyId, p_sent_at: sentAt, p_channel: "linkedin" });
      } catch {
        /* bookkeeping only */
      }
    }
  }
  return marked;
}

function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fallback when no enrollment carries the attendee's LinkedIn identity: match
 * by full name among recent enrollments. Most research-table enrollments have
 * no contact_linkedin, or a vanity URL that never equals the provider id the
 * chat exposes, so identity matching alone left most replies unmatched and
 * the sequences "paused" by hand. First + last name must both agree; a bare
 * first name is not a match.
 */
type NameMatchRow = {
  id: string;
  status: string;
  sequence_id: string | null;
  contact_linkedin: string | null;
  contact_name: string | null;
  contact_email: string | null;
  company_name: string | null;
  created_at: string | null;
};

/** Recent enrollments with a name, loaded once and matched in memory. */
export async function loadEnrollmentsForNameMatch(
  client: SupabaseClient,
  sinceDays = 120,
): Promise<NameMatchRow[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data, error } = await client
    .from("outreach_enrollments")
    .select(
      "id, status, sequence_id, contact_linkedin, contact_name, contact_email, company_name, created_at",
    )
    .not("contact_name", "is", null)
    .gte("created_at", since)
    .order("updated_at", { ascending: false })
    .limit(3000);
  if (error) throw new Error(error.message);
  return (data ?? []) as NameMatchRow[];
}

export async function findEnrollmentsByContactName(
  client: SupabaseClient,
  name: string | null | undefined,
  opts?: { sinceDays?: number; rows?: NameMatchRow[] },
): Promise<EnrollmentHit[]> {
  const wanted = normalizeName(name);
  const parts = wanted.split(" ");
  if (parts.length < 2) return [];
  const data = opts?.rows ?? (await loadEnrollmentsForNameMatch(client, opts?.sinceDays));
  const hits: EnrollmentHit[] = [];
  for (const row of data ?? []) {
    const n = normalizeName(row.contact_name as string);
    const p = n.split(" ");
    if (p.length < 2) continue;
    // "Bruno Henrique" on the enrollment, "Bruno Henrique Ramos Fernandes"
    // on LinkedIn: the shorter name as a prefix of the longer one counts.
    const same =
      n === wanted ||
      wanted.startsWith(`${n} `) ||
      n.startsWith(`${wanted} `) ||
      (p[0] === parts[0] && p[p.length - 1] === parts[parts.length - 1]);
    if (!same) continue;
    hits.push({
      id: row.id as string,
      status: row.status as string,
      sequenceId: (row.sequence_id as string | null) ?? null,
      contactLinkedin: (row.contact_linkedin as string | null) ?? null,
      contactName: (row.contact_name as string | null) ?? null,
      contactEmail: (row.contact_email as string | null) ?? null,
      companyName: (row.company_name as string) || "",
      createdAt: (row.created_at as string | null) ?? null,
    });
  }
  // Two people with the same name at different companies: a name alone
  // cannot say which one wrote, and stopping the wrong sequence is worse
  // than leaving both running. Identity matching still finds them.
  const companies = new Set(hits.map((h) => normalizeName(h.companyName)));
  if (companies.size > 1) {
    console.warn("[unipile] name matches several companies, skipped:", wanted, [...companies]);
    return [];
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
      // Same rule as the Gmail sync: stop the cadence now, but leave an
      // excluded account excluded until the classifier confirms a human wrote
      // this. reconcileEnrollmentForReplyClass applies the revive after.
      revive: false,
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

  const chatLimit = Math.min(300, Math.max(5, opts?.chatLimit ?? 40));
  const messagesPerChat = Math.min(40, Math.max(5, opts?.messagesPerChat ?? 20));

  let accounts = 0;
  let chatsScanned = 0;
  let threadsTouched = 0;
  let messagesUpserted = 0;
  let enrollmentsMarkedReplied = 0;
  const threadIds = new Set<string>();
  const enrollmentsStopped = new Set<string>();
  // Enrollments for the name fallback, loaded on first use and shared by
  // every chat in this run instead of one 3000-row query per chat.
  let nameRows: Awaited<ReturnType<typeof loadEnrollmentsForNameMatch>> | null = null;

  try {
    const liAccounts = await listLinkedInAccounts();
    accounts = liAccounts.length;

    for (const account of liAccounts) {
      // Unipile pages at 100; follow the cursor until chatLimit so a busy
      // inbox (150+ chats a fortnight) is not cut at the first page.
      const chats: Awaited<ReturnType<typeof listUnipileChats>>["items"] = [];
      let cursor: string | null = null;
      do {
        const page = await listUnipileChats({
          accountId: account.id,
          limit: Math.min(100, chatLimit - chats.length),
          cursor,
        });
        chats.push(...page.items);
        cursor = page.cursor;
      } while (cursor && chats.length < chatLimit);

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

        let enrollments = await findEnrollmentsByLinkedInIdentities(
          client,
          expanded,
        );
        if (enrollments.length === 0 && other?.name) {
          nameRows ??= await loadEnrollmentsForNameMatch(client);
          enrollments = await findEnrollmentsByContactName(client, other.name, { rows: nameRows });
        }
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
              // The name fallback still means "matched through the LinkedIn
              // chat"; matched_how has a CHECK constraint and no value for it.
              matchedHow: "linkedin_profile",
            });
            threadIds.add(upserted.threadId);
            if (upserted.messageUpserted) messagesUpserted += 1;
          } catch (err) {
            console.warn("[unipile] sync upsert failed", chat.id, msg.id, err);
          }
        }

        // Stop sequences for matched enrollments, but only when the person
        // wrote back AFTER this enrollment started. A LinkedIn chat keeps the
        // whole history: a "não, nossos desafios são outros" from 2024 sat in
        // the same thread as the 2026 sequence and marked it replied, which
        // put five silent accounts in the reply count and moved them to
        // engaged in the CRM.
        // Our own messages in this chat: manual sends the engine never saw.
        // The thread belongs to the primary enrollment (the one the messages
        // were upserted under), so only it gets the sends; a contact with
        // two enrollments would otherwise count every message twice.
        const outboundTs = messages
          .filter((m) => m.isSender && m.timestamp)
          .map((m) => m.timestamp as string);
        if (outboundTs.length) {
          try {
            const { data: enrRow } = await client
              .from("outreach_enrollments")
              .select("crm_company_id")
              .eq("id", primary.id)
              .maybeSingle();
            await reconcileManualLinkedInSends(
              client,
              primary,
              outboundTs,
              (enrRow?.crm_company_id as string | null) ?? null,
            );
          } catch (err) {
            console.warn("[unipile] reconcile manual sends failed", primary.id, err);
          }
        }

        const inboundDates = inbound
          .map((m) => (m.timestamp ? Date.parse(m.timestamp) : NaN))
          .filter((t) => Number.isFinite(t));
        const latestInbound = inboundDates.length ? Math.max(...inboundDates) : null;
        for (const enr of stoppable) {
          if (enrollmentsStopped.has(enr.id)) continue;
          if (enr.status === "replied") {
            enrollmentsStopped.add(enr.id);
            continue;
          }
          // Skip only when both dates are known and the last reply predates
          // the enrollment; a message without a parseable date is still a
          // reply.
          const startedAt = enr.createdAt ? Date.parse(enr.createdAt) : NaN;
          if (latestInbound != null && Number.isFinite(startedAt) && latestInbound < startedAt) continue;
          try {
            await markEnrollmentReplied(client, enr.id, {
              revive: false,
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
