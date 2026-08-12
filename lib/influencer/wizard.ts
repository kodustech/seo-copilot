import { generateObject } from "ai";
import { z } from "zod";

import { getModel } from "@/lib/ai/provider";
import { generateGeminiImage } from "@/lib/copilot";

export const DEFAULT_DISCLOSURE =
  "I'm an AI agent, built and operated by the team at Kodus (kodus.io).";

export type PersonaProposal = {
  handle: string;
  display_name: string;
  bio: string;
  backstory: string;
  disclosure: string;
  beat: string;
  tone: string;
  writing_guidelines: string;
  preferred_words: string[];
  forbidden_words: string[];
  allowed_topics: string[];
  forbidden_topics: string[];
  avatar_prompt: string;
};

export type ExistingPersonaSummary = {
  handle: string;
  beat: string;
  tone: string | null;
};

const ProposalSchema = z.object({
  handle: z
    .string()
    .describe("lowercase handle, letters/digits/underscore only, no @"),
  display_name: z.string(),
  bio: z
    .string()
    .describe(
      "Platform bio, max 140 chars, WITHOUT the AI disclosure line (appended separately)",
    ),
  backstory: z
    .string()
    .describe(
      "The character's worldview and history in 3-6 sentences: what it reads, what it believes about software, what it is skeptical of",
    ),
  beat: z.string().describe("The niche this persona covers, in a short phrase"),
  tone: z.string().describe("Voice description in 2-3 sentences"),
  writing_guidelines: z
    .string()
    .describe("Concrete do/don't writing rules for this character"),
  preferred_words: z.array(z.string()).describe("5-10 words/expressions it favors"),
  forbidden_words: z.array(z.string()).describe("5-10 words it would never use"),
  allowed_topics: z.array(z.string()).describe("Topics it covers"),
  forbidden_topics: z
    .array(z.string())
    .describe("Topics it must never opine on (politics, religion, competitors by name...)"),
  avatar_prompt: z
    .string()
    .describe(
      "Image-generation prompt for the avatar: stylized/illustrated, clearly non-photorealistic (it must not look like a real human photo)",
    ),
});

export async function generatePersonaProposal({
  direction,
  objective,
  language,
  existing,
}: {
  direction: string;
  objective?: string;
  language?: string;
  existing: ExistingPersonaSummary[];
}): Promise<PersonaProposal> {
  const trimmed = direction.trim();
  if (!trimmed) {
    throw new Error("Describe the niche/direction for the new persona.");
  }

  const fleetContext = existing.length
    ? [
        "EXISTING FLEET — the new persona must be clearly distinct from every one of these in beat, tone and mannerisms:",
        ...existing.map(
          (p) => `- @${p.handle}: beat "${p.beat}"${p.tone ? `; tone: ${p.tone}` : ""}`,
        ),
      ].join("\n")
    : "This is the first persona of the fleet.";

  const { object } = await generateObject({
    model: getModel(),
    schema: ProposalSchema,
    system: [
      "You design fictional dev-influencer characters for Kodus, a company building AI code review tooling.",
      "Every character is OPENLY an AI agent — the account bio carries a disclosure line (added separately, don't write it).",
      "Design a character a senior developer would actually follow: specific taste, real opinions, a narrow beat.",
      "Avoid generic 'passionate about technology' personas. Give it edges: things it dislikes, hills it dies on.",
      "The character must never impersonate a real person; the name must not collide with a well-known figure.",
      fleetContext,
    ].join("\n\n"),
    prompt: [
      `Niche/direction: ${trimmed}`,
      objective ? `Marketing objective: ${objective.trim()}` : "",
      `Content language: ${language?.trim() || "en-US"}`,
      "Design the persona now.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return {
    ...object,
    handle: object.handle
      .trim()
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 24),
    disclosure: DEFAULT_DISCLOSURE,
  };
}

/**
 * Avatar for a persona. Returned as a data URI; personas.avatar_url stores it
 * directly — fine at fleet scale (a handful of rows), revisit if that grows.
 */
export async function generatePersonaAvatar({
  avatarPrompt,
}: {
  avatarPrompt: string;
}): Promise<string> {
  const { dataUri } = await generateGeminiImage({
    prompt: [
      avatarPrompt.trim(),
      "Square social-media avatar, centered subject, simple background.",
      "Stylized illustration — explicitly NOT photorealistic, must not be mistaken for a photo of a real person.",
    ].join(" "),
  });
  return dataUri;
}
