import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { getModel } from "@/lib/ai/provider";
import { GROWTH_AGENT_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { createAgentTools } from "@/lib/ai/tools";
import { hermesEnabled, streamHermesChat } from "@/lib/ai/hermes";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const maxDuration = 300;

export async function POST(req: Request) {
  let userEmail: string;
  try {
    const { userEmail: email } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    userEmail = email;
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const uiMessages = body.messages ?? [];
    const conversationId =
      (body.conversationId as string | undefined) ??
      (body.id as string | undefined) ??
      null;

    const systemWithUser = `${GROWTH_AGENT_SYSTEM_PROMPT}\n\n## User Context\nLogged-in user email: ${userEmail}\nUse this email context for user-scoped tools (scheduled jobs and social scheduling integrations).`;

    // Prefer Hermes when configured — same agent as Discord/Slack/WhatsApp gateway
    if (hermesEnabled()) {
      try {
        return await streamHermesChat({
          messages: uiMessages,
          system: systemWithUser,
          userEmail,
          conversationId,
        });
      } catch (err) {
        console.error("[agent/chat] Hermes failed, falling back to local:", err);
        // fall through to local streamText
      }
    }

    const messages = await convertToModelMessages(uiMessages);

    const result = streamText({
      model: getModel(),
      system: systemWithUser,
      messages,
      tools: createAgentTools(userEmail),
      stopWhen: stepCountIs(10),
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    console.error("[agent/chat] Error:", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Internal server error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
