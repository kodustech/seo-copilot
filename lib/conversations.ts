import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Conversation = {
  id: string;
  user_email: string;
  title: string;
  messages: UIMessage[];
  created_at: string;
  updated_at: string;
};

export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "created_at" | "updated_at"
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateTitleFromMessage(text: string): string {
  const clean = text.replace(/\n/g, " ").trim();
  if (clean.length <= 80) return clean;
  return clean.slice(0, 77) + "...";
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createConversation(
  client: SupabaseClient,
  data: {
    user_email: string;
    title?: string;
    messages?: UIMessage[];
  },
): Promise<Conversation> {
  const { data: conv, error } = await client
    .from("conversations")
    .insert({
      user_email: data.user_email,
      title: data.title ?? "Nova conversa",
      messages: data.messages ?? [],
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar conversa: ${error.message}`);
  return conv as Conversation;
}

export async function listConversationsByEmail(
  client: SupabaseClient,
  email: string,
): Promise<ConversationSummary[]> {
  const { data, error } = await client
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("user_email", email)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`Erro ao listar conversas: ${error.message}`);
  return (data ?? []) as ConversationSummary[];
}

export async function getConversationById(
  client: SupabaseClient,
  id: string,
  email: string,
): Promise<Conversation | null> {
  const { data, error } = await client
    .from("conversations")
    .select("*")
    .eq("id", id)
    .eq("user_email", email)
    .single();

  if (error) return null;
  return data as Conversation;
}

export async function updateConversationMessages(
  client: SupabaseClient,
  id: string,
  email: string,
  messages: UIMessage[],
  title?: string,
): Promise<void> {
  const update: Record<string, unknown> = {
    messages,
    updated_at: new Date().toISOString(),
  };
  if (title) update.title = title;

  const { error } = await client
    .from("conversations")
    .update(update)
    .eq("id", id)
    .eq("user_email", email);

  if (error) throw new Error(`Erro ao atualizar conversa: ${error.message}`);
}

export async function deleteConversation(
  client: SupabaseClient,
  id: string,
  email: string,
): Promise<void> {
  const { error } = await client
    .from("conversations")
    .delete()
    .eq("id", id)
    .eq("user_email", email);

  if (error) throw new Error(`Erro ao deletar conversa: ${error.message}`);
}
