import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { getModel } from "@/lib/ai/provider";
import { GROWTH_AGENT_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { agentTools } from "@/lib/ai/tools";

export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages: uiMessages, userEmail } = await req.json();
  const messages = await convertToModelMessages(uiMessages);

  const systemWithUser = userEmail
    ? `${GROWTH_AGENT_SYSTEM_PROMPT}\n\n## Contexto do Usuário\nEmail do usuário logado: ${userEmail}\nQuando usar tools de scheduled jobs, SEMPRE passe este email no campo user_email.`
    : GROWTH_AGENT_SYSTEM_PROMPT;

  const result = streamText({
    model: getModel(),
    system: systemWithUser,
    messages,
    tools: agentTools,
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}
