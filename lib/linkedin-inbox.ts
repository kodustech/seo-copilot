/**
 * LinkedIn DMs for the agent (linkedinListChats, linkedinGetChat). Read-only,
 * over the same Unipile account and the same calls as the reply sync — but it
 * sees every conversation, not only the ones tied to a sequence.
 *
 * Unipile's chat list carries no name for a 1:1 chat, only the other side's
 * member id, so each chat costs one attendee call. Those run one at a time,
 * like the reply sync, to keep the connected account's traffic unremarkable.
 */

import {
  listLinkedInAccounts,
  listUnipileChatAttendees,
  listUnipileChatMessages,
  listUnipileChats,
  type UnipileChatAttendee,
  type UnipileChatMessage,
} from "@/lib/unipile";

export type LinkedInChatSummary = {
  chat_id: string;
  name: string | null;
  profile_url: string | null;
  last_activity_at: string | null;
  unread_count: number;
};

export type LinkedInChatMessage = {
  from_me: boolean;
  text: string | null;
  at: string | null;
};

/** The named account, or the first connected one (same default as the send tool). */
export async function resolveLinkedInAccount(
  accountId?: string | null,
): Promise<string> {
  if (accountId?.trim()) return accountId.trim();
  const accounts = await listLinkedInAccounts();
  if (!accounts.length) throw new Error("No LinkedIn account connected in Unipile");
  return accounts[0].id;
}

async function otherAttendee(
  accountId: string,
  chatId: string,
): Promise<UnipileChatAttendee | null> {
  try {
    const attendees = await listUnipileChatAttendees({ accountId, chatId });
    return attendees.find((a) => !a.isSelf) ?? null;
  } catch {
    // A missing name should not hide the conversation itself.
    return null;
  }
}

export async function listLinkedInChats(opts: {
  accountId: string;
  limit: number;
}): Promise<LinkedInChatSummary[]> {
  const { items } = await listUnipileChats({
    accountId: opts.accountId,
    limit: opts.limit,
  });
  const chats: LinkedInChatSummary[] = [];
  for (const chat of items) {
    const other = await otherAttendee(opts.accountId, chat.id);
    chats.push({
      chat_id: chat.id,
      name: other?.name ?? null,
      profile_url: other?.profileUrl ?? null,
      last_activity_at: chat.timestamp,
      unread_count: chat.unreadCount,
    });
  }
  return chats;
}

/** Oldest first, so the conversation reads top to bottom. */
export function orderChatMessages(
  messages: UnipileChatMessage[],
): LinkedInChatMessage[] {
  return [...messages]
    .sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return ta - tb;
    })
    .map((m) => ({ from_me: m.isSender, text: m.text, at: m.timestamp }));
}

export async function getLinkedInChat(opts: {
  accountId: string;
  chatId: string;
  limit: number;
}): Promise<{
  with: { name: string | null; profile_url: string | null };
  messages: LinkedInChatMessage[];
}> {
  const messages = await listUnipileChatMessages({
    chatId: opts.chatId,
    limit: opts.limit,
  });
  const other = await otherAttendee(opts.accountId, opts.chatId);
  return {
    with: { name: other?.name ?? null, profile_url: other?.profileUrl ?? null },
    messages: orderChatMessages(messages),
  };
}
