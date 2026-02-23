import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { getModel } from "@/lib/ai/provider";
import { GROWTH_AGENT_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { createAgentTools } from "@/lib/ai/tools";
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

  const { messages: uiMessages } = await req.json();
  const messages = await convertToModelMessages(uiMessages);

  const systemWithUser = `${GROWTH_AGENT_SYSTEM_PROMPT}\n\n## User Context\nLogged-in user email: ${userEmail}\nUse this email context for user-scoped tools (scheduled jobs and social scheduling integrations).`;

  const result = streamText({
    model: getModel(),
    system: systemWithUser,
    messages,
    tools: createAgentTools(userEmail),
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}
