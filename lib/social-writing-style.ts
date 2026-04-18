type PlatformConfigLike = {
  platform: string;
  maxLength?: number;
  numVariations?: number;
  linksPolicy?: string;
  ctaStyle?: string;
  hashtagsPolicy?: string;
};

type BuildSocialInstructionsInput = {
  instructions?: string;
  contentSource?: string;
  generationMode?: string;
  platformConfigs?: PlatformConfigLike[];
};

const SOCIAL_STYLE_GUIDE = `Write social posts in a personal technical operator voice, not as a generic brand account.

Voice:
- Sound like a founder/builder who is close to engineering work and product decisions.
- Be direct, specific, and a little opinionated. Prefer "here is what we learned" over polished marketing copy.
- Use first person when it fits the source material. Do not invent personal stories, metrics, or claims that are not supported by the input.
- Keep the language human and hand-edited. Avoid generic AI phrasing, corporate filler, and motivational fluff.

Content quality:
- Start from one concrete observation, tension, mistake, lesson, or trade-off.
- Make the post useful for senior engineers, engineering managers, founders, or technical operators.
- Include a practical takeaway. If there is no takeaway, make the post sharper before writing.
- Do not summarize the source mechanically. Turn it into a point of view.

Avoid:
- "game changer", "revolutionary", "unlock", "supercharge", "leverage", "seamless", "dive into", "ever-evolving", "in today's fast-paced world"
- empty hype, exaggerated certainty, fake vulnerability, generic lists, and engagement bait.`;

export const SOCIAL_FORMATTING_HINT =
  "Separate paragraphs with one blank line and keep blocks short. Make every line earn its place.";

export const DEFAULT_SOCIAL_VARIATION_STRATEGY =
  "Make each variation meaningfully different: one contrarian take, one practical lesson, one build-in-public observation, one tactical checklist, or one question-led post. Do not only rewrite the same idea with different hooks.";

function platformRules(platformConfigs?: PlatformConfigLike[]): string {
  const platforms = new Set(
    (platformConfigs ?? [])
      .map((config) => config.platform.trim().toLowerCase())
      .filter(Boolean),
  );

  const rules: string[] = [];

  if (platforms.has("linkedin")) {
    rules.push(`LinkedIn:
- Use short paragraphs and a clear narrative arc: hook -> context -> lesson -> practical takeaway.
- Prefer 80-180 words unless maxLength is tighter.
- One idea per post. No generic "thought leadership" tone.
- CTA should invite a real discussion, not beg for engagement.
- Use at most 3 specific hashtags only when they add context.`);
  }

  if (platforms.has("twitter") || platforms.has("x") || platforms.has("twitter / x")) {
    rules.push(`Twitter/X:
- One sharp idea. Cut setup, throat-clearing, and corporate language.
- Fit the configured maxLength. If maxLength is above 280, write like a compact thread starter, not a LinkedIn post.
- Prefer a strong sentence, concrete example, or useful question.
- Avoid hashtags unless explicitly requested.`);
  }

  if (platforms.has("instagram")) {
    rules.push(`Instagram:
- Write a caption that can support a visual or carousel.
- Keep the first line concrete and scannable.
- Use a conversational explanation and a soft CTA.`);
  }

  if (!rules.length) {
    rules.push(`Platform adaptation:
- Match the requested platform and maxLength.
- Do not use the same structure for every platform.`);
  }

  return rules.join("\n\n");
}

function sourceRules(contentSource?: string, generationMode?: string): string {
  const rules: string[] = [];

  if (generationMode === "adversarial") {
    rules.push(
      "For adversarial posts, identify a common belief or dominant narrative the source implies or states, then push back with a grounded counter-position. The pushback must be defensible and aligned with the author's worldview (provided separately). Do not strawman. Do not be edgy for the sake of it.",
    );
  } else if (contentSource === "changelog" || generationMode === "build_in_public") {
    rules.push(
      "For build-in-public posts, explain what changed, why it mattered, the trade-off behind it, and what the team learned. Keep it candid and concrete.",
    );
  } else if (contentSource === "blog") {
    rules.push(
      "For blog-based posts, do not just tease the article. Extract one useful opinion, framework, or lesson from it and make the post stand alone.",
    );
  }

  if (!rules.length) {
    rules.push(
      "Use the source as raw material for a point of view. The post must still be useful without the reader opening a link.",
    );
  }

  return rules.join("\n");
}

function normalizePart(value?: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildSocialInstructions({
  instructions,
  contentSource,
  generationMode,
  platformConfigs,
}: BuildSocialInstructionsInput): string {
  const parts = [
    `Social writing style:\n${SOCIAL_STYLE_GUIDE}`,
    `Source handling:\n${sourceRules(contentSource, generationMode)}`,
    `Platform rules:\n${platformRules(platformConfigs)}`,
    `Formatting:\n${SOCIAL_FORMATTING_HINT}`,
    normalizePart(instructions)
      ? `Task-specific instructions:\n${normalizePart(instructions)}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join("\n\n");
}

export function buildSocialVariationStrategy(strategy?: string): string {
  const specificStrategy = normalizePart(strategy);
  if (!specificStrategy) {
    return DEFAULT_SOCIAL_VARIATION_STRATEGY;
  }

  return `${DEFAULT_SOCIAL_VARIATION_STRATEGY}\n\nAdditional variation request:\n${specificStrategy}`;
}

