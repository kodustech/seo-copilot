/**
 * Match Unipile LinkedIn inbound messages to sequence enrollments and mark replied.
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

/**
 * Find active (or recently active) enrollments whose LinkedIn identity matches
 * any of the webhook counterpart identities.
 */
export async function findEnrollmentsByLinkedInIdentities(
  client: SupabaseClient,
  identities: string[],
): Promise<
  Array<{
    id: string;
    status: string;
    contactLinkedin: string | null;
    companyName: string;
  }>
> {
  if (identities.length === 0) return [];

  const identitySet = new Set(identities.map((i) => i.toLowerCase()));

  // Pull enrollments that have a LinkedIn URL (bounded).
  const { data, error } = await client
    .from("outreach_enrollments")
    .select("id, status, contact_linkedin, company_name")
    .not("contact_linkedin", "is", null)
    .order("updated_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const hits: Array<{
    id: string;
    status: string;
    contactLinkedin: string | null;
    companyName: string;
  }> = [];

  for (const row of data ?? []) {
    const keys = enrollmentLinkedInKeys(row.contact_linkedin as string | null);
    if (keys.some((k) => identitySet.has(k))) {
      hits.push({
        id: row.id as string,
        status: row.status as string,
        contactLinkedin: (row.contact_linkedin as string | null) ?? null,
        companyName: (row.company_name as string) || "",
      });
    }
  }
  return hits;
}

/**
 * Process Unipile message_received webhook for LinkedIn replies.
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
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: `ignored account_type=${accountType}`,
    };
  }

  if (payload.event && payload.event !== "message_received") {
    return {
      handled: false,
      outbound: false,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: `ignored event=${payload.event}`,
    };
  }

  if (isOutboundUnipileMessage(payload)) {
    return {
      handled: false,
      outbound: true,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: "outbound message (sent by us)",
    };
  }

  const identities = identitiesFromWebhook(payload);
  if (identities.length === 0) {
    return {
      handled: false,
      outbound: false,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: "no counterpart identities on webhook",
    };
  }

  const enrollments = await findEnrollmentsByLinkedInIdentities(
    client,
    identities,
  );
  // Prefer non-terminal or replied-upgradeable enrollments
  const candidates = enrollments.filter(
    (e) =>
      e.status === "active" ||
      e.status === "paused" ||
      e.status === "completed" ||
      e.status === "replied",
  );

  if (candidates.length === 0) {
    return {
      handled: false,
      outbound: false,
      matchedEnrollmentIds: [],
      crmCompanyIds: [],
      reason: `no enrollment match for ${identities.join(",")}`,
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
    handled: matchedEnrollmentIds.length > 0,
    outbound: false,
    matchedEnrollmentIds,
    crmCompanyIds: [...new Set(crmCompanyIds)],
  };
}
