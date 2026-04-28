import {
  formatSourceAttachmentsForPrompt,
  type SourceAttachmentPayload,
} from "@/lib/source-attachments";

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
  sourcePerspective?: SocialSourcePerspective;
  narrativeStyle?: SocialNarrativeStyle;
  platformConfigs?: PlatformConfigLike[];
};

type BuildSocialWriterPromptInput = BuildSocialInstructionsInput & {
  baseContent: string;
  language: string;
  tone?: string;
  variationStrategy: string;
  sourceAttachments?: SourceAttachmentPayload[];
  voicePolicyPrompt?: string | null;
  worldview?: string | null;
};

export type SocialSourcePerspective = "owned" | "observed" | "inspired";
export type SocialNarrativeStyle =
  | "analysis"
  | "storytelling"
  | "hot_take"
  | "lesson";

const SOCIAL_STYLE_GUIDE = `Write social posts in a technical operator voice with a clear point of view, not as a generic brand account.

Voice:
- Sound like someone close to engineering work and product decisions.
- Be direct, specific, and a little opinionated. Prefer grounded analysis over polished marketing copy.
- Do not turn third-party material into the author's personal story. Never write as if an external outage, postmortem, bug, benchmark, tool search, or company decision happened to the author or Kodus.
- Use first person only when the source is clearly about the author's own company, product, team, or experience, or when the task-specific instructions explicitly ask for it.
- Keep the language human and hand-edited. Avoid generic AI phrasing, corporate filler, and motivational fluff.

Content quality:
- Start from one concrete observation, tension, mistake, lesson, or trade-off.
- Make the post useful for senior engineers, engineering managers, founders, or technical operators.
- Include a practical next step or concrete lesson. If there is none, make the post more specific before writing.
- Do not summarize the source mechanically. Turn it into a point of view.

Avoid:
- "game changer", "revolutionary", "unlock", "supercharge", "leverage", "seamless", "dive into", "ever-evolving", "in today's fast-paced world"
- empty hype, exaggerated certainty, fake vulnerability, generic lists, and engagement bait.`;

export const SOCIAL_FORMATTING_HINT =
  "Separate paragraphs with one blank line and keep blocks short. Make every line earn its place. Preserve those paragraph breaks inside the returned JSON string using newline characters.";

export const DEFAULT_SOCIAL_VARIATION_STRATEGY =
  "Make each variation meaningfully different: one contrarian take, one practical lesson, one build-in-public observation, one tactical checklist, or one question-led post. Do not only rewrite the same idea with different hooks.";

export const SOCIAL_ANTI_AI_GUARDRAILS = `Rules never to break:
- No em dashes. Use commas, periods, parentheses, or line breaks.
- No rule-of-three lists. Do not group things into trios. Two items is fine. Four or five is fine.
- No contrast framing. Do not write "it is not X, it is Y", "this is not X, it is Y", "not X but Y", "not only X but also Y", "more than X, it is Y", or "X? No. Actually Y."
- No staccato bursts. Do not string together three or more short sentences for drama.
- No rhetorical transition questions like "The catch?", "The kicker?", "But here is the thing", "So what does this mean?", "Why does this matter?", or "Thoughts?"
- No "nobody" as a dramatic opener.
- No emojis in professional writing.
- No "let's" openers.
- No fake naming. Do not invent named methods, frameworks, flywheels, paradoxes, or capitalized concepts.
- No self-narration. Delete phrases whose only job is to announce the point.

Avoid these transition words:
Arguably, Certainly, Consequently, Hence, However as a sentence opener, Indeed, Moreover, Nevertheless, Nonetheless, Thus, Undoubtedly, Accordingly, Additionally, On the contrary, Furthermore, Notably, Essentially, Fundamentally, Inherently, Particularly as a sentence opener.

Avoid these AI-overused adjectives:
Adept, Commendable, Compelling, Comprehensive, Crucial, Cutting-edge, Dynamic, Efficient, Ever-evolving, Exciting, Exemplary, Game-changing, Genuine, Groundbreaking, Holistic, Innovative, Invaluable, Meticulous, Multifaceted, Noteworthy, Nuanced, Paramount, Pivotal, Profound, Remarkable, Robust, Scalable, Seamless, Significant, State-of-the-art, Streamlined, Substantial, Synergistic, Tailored, Thought-provoking, Transformative, Unprecedented, Vibrant, Vital, hidden, invisible, sharp, powerful, effective, subtle.

Avoid these AI-overused adverbs:
Drastically, Genuinely, Meticulously, Notably, Profoundly, Remarkably, Significantly, Strategically, Substantially, Truly.

Avoid these abstract nouns when they are figurative or vague:
Bandwidth, Bedrock, Cadence, Catalyst, Cornerstone, Deep dive, Ecosystem, Efficiency, Framework, Game-changer, Guardrails, Headwinds, Tailwinds, Implementation, Innovation, Institution, Integration, Interplay, Intersection, Intricacies, Juxtaposition, Landscape, Linchpin, North star, Optimization, Pain point, Paradigm, Paradigm shift, Realm, Synergy, Takeaway, Key takeaway, Tapestry, Transformation, friction.

Avoid these verbs:
Aligns, Amplify, Augment, Bolster, Catalyze, Craft as a figurative verb, Cultivate, Curate, Delve, Demystify, Dive in, Double down, Elevate, Embark, Empower, Enhance, Facilitate, Foster, Garner, Harness, Leverage, Maximize, Navigate as a figurative verb, Reimagine, Resonate, Revolutionize, Showcase, Spearhead, Streamline, Underscore, Unlock as a figurative verb, Unpack as a figurative verb, Utilize, Explore.

Delete these phrases and framings:
"A testament to", "In conclusion", "In summary", "It is important to note", "It is worth noting", "This is not an exhaustive list", "At its core", "In today's fast-paced world", "In today's rapidly evolving landscape", "At the end of the day", "Moving forward", "That said", "That being said", "With that in mind", "When it comes to", "In terms of", "At the intersection of", "Here is the thing", "Make no mistake", "Simply put", "To put it simply", "In a nutshell", "The reality is", "Let that sink in", "Read that again", "Full stop", "Period" as emphasis, "Think about that for a second", "This cannot be overstated", "It bears mentioning", "What is more", "To be sure", "First and foremost", "Last but not least", "Needless to say", "It goes without saying", "Rest assured", "Here is why that matters", "And that is okay", "Spoiler alert", "Hot take", "Pro tip", "The takeaway", "The bottom line", "Level up", "Move the needle", "Low-hanging fruit", "Circle back", "The elephant in the room", "Only time will tell", "Stands out as", "Serves as a reminder", "Paves the way for", "Sheds light on", "Bridges the gap", "Strikes a balance", "Pushes the envelope", "Raises the bar", "This highlights", "This underscores", "This speaks to", "This illustrates", "This demonstrates", "This signals", "This points to", "This reflects", "This suggests that", "This is a clear sign that", "This is a reminder that", "Here is the real story", "Here is what is really going on", "The key takeaway is", "The big picture here is", "The real lesson here is", "The important thing is", "The point is", "Now for the interesting part", "And that is where it gets interesting", "Which brings us to the real question", "What does this tell us", "What does this mean", "Why should you care", "And here is what most people miss", "And here is the best part", "And here is the crazy part", "And that is exactly why", "And that is the point".

Use plain replacements:
utilize -> use, execute -> do, facilitate -> help, expedite -> speed up, implement -> start or build, optimize -> improve, leverage -> use, garner -> get, delve -> look at, underscore -> show, embark -> start, augment -> add to, maximize -> increase, align -> match, cultivate -> build or grow, harness -> use, bolster -> support, catalyze -> start or cause, amplify -> increase, elevate -> raise or improve, empower -> let or enable, navigate -> handle or deal with, spearhead -> lead, streamline -> simplify, curate -> pick or choose, craft -> write or make, unpack -> explain, demystify -> explain, reimagine -> rethink or redo, resonate -> connect or land.

Remove these content patterns:
- Significance inflation. Do not announce importance. Show why with specifics.
- Promotional tone. No travel-brochure or launch-copy language.
- Vague attribution like "experts say", "industry observers note", or "some critics argue" without named sources.
- Generic positive endings like "the future looks bright" or "this is a major step in the right direction".
- False ranges like "from X to Y" unless X and Y are a real spectrum.
- Synonym cycling. Pick one name for the subject and keep it.

Remove these language patterns:
- Copula avoidance. Prefer "is" over "serves as", "stands as", "functions as", or "represents".
- Ing-phrase padding at the end of sentences.
- Boldface abuse.
- Vertical lists with inline headers.
- Title case unless it is a proper noun.
- Curly quotes.
- Filler like "in order to", "due to the fact that", "at this point in time", "has the ability to", and "in the event that".
- Excessive hedging. One qualifier per claim is enough.

Naturalness guardrails:
- Write like a real person explaining something to a colleague in Slack.
- Avoid article voice, LinkedIn coach voice, press release voice, and debate-bro voice.
- Vary rhythm without using dramatic one-line punchlines.
- Have opinions, but keep them grounded.
- Acknowledge mixed feelings when the source supports them.
- Leave some imperfection. Perfect structure feels generated.`;

function platformRules(platformConfigs?: PlatformConfigLike[]): string {
  const platforms = new Set(
    (platformConfigs ?? [])
      .map((config) => config.platform.trim().toLowerCase())
      .filter(Boolean),
  );

  const rules: string[] = [];

  if (platforms.has("linkedin")) {
    rules.push(`LinkedIn:
- Use short paragraphs and a clear narrative arc: hook -> context -> lesson -> practical next step.
- Prefer 80-180 words unless maxLength is tighter.
- One idea per post. No generic "thought leadership" tone.
- CTA should invite a real discussion, not beg for engagement.
- Use at most 3 specific hashtags only when they add context.`);
  }

  if (platforms.has("twitter") || platforms.has("x") || platforms.has("twitter / x")) {
    rules.push(`Twitter/X:
- One clear idea. Cut setup, throat-clearing, and corporate language.
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

function perspectiveRules(sourcePerspective?: SocialSourcePerspective): string {
  if (sourcePerspective === "owned") {
    return [
      "Source perspective: owned.",
      "The source is about the author's own company, product, team, or shipped work. First-person plural is allowed when the input supports it. Keep ownership concrete: say what changed, why it mattered, and what was learned without inventing extra incidents, metrics, or emotions.",
    ].join("\n");
  }

  if (sourcePerspective === "observed") {
    return [
      "Source perspective: observed.",
      "The author read, saw, or is reacting to third-party material. Write as commentary from the outside. Phrases like 'this postmortem shows', 'after reading this', or 'the comparison points to' are allowed. Do not write 'we had this bug', 'our postmortem', 'I was looking for a tool', or anything that makes the external event sound like the author's experience.",
    ].join("\n");
  }

  if (sourcePerspective === "inspired") {
    return [
      "Source perspective: inspired.",
      "Use the source as raw material for a useful point of view. The post does not need to mention that the author read the source, and it must not claim the source's events as the author's own experience.",
    ].join("\n");
  }

  return [
    "Source perspective: infer conservatively.",
    "If ownership is unclear, treat the source as observed or inspired, never as the author's personal story.",
  ].join("\n");
}

function narrativeRules(narrativeStyle?: SocialNarrativeStyle): string {
  if (narrativeStyle === "storytelling") {
    return "Narrative style: storytelling. Use a small narrative arc only within the allowed source perspective. If the source is observed, tell the source's story or the author's reading of it, not a fake first-person incident.";
  }

  if (narrativeStyle === "hot_take") {
    return "Narrative style: hot take. Make one direct, defensible claim with concrete support. Push against an idea or framing, not against a person or brand for drama.";
  }

  if (narrativeStyle === "lesson") {
    return "Narrative style: lesson. Extract a practical lesson, rule of thumb, or decision rule. Avoid fake anecdotes and avoid pretending the lesson came from the author's own mistake unless the input says so.";
  }

  return "Narrative style: analysis. Lead with a concrete observation, explain the implication, and keep ownership of events clear.";
}

function sourceRules(
  contentSource?: string,
  generationMode?: string,
  sourcePerspective?: SocialSourcePerspective,
): string {
  const rules: string[] = [];

  if (generationMode === "adversarial") {
    rules.push(
      sourcePerspective === "owned"
        ? "For adversarial posts about owned material, push back on a common belief or dominant narrative using the author's actual company, product, team, or shipped work as support. Do not invent internal incidents, metrics, or customer stories. The pushback must be defensible and aligned with the author's worldview (provided separately). Do not strawman. Do not be edgy for the sake of it."
        : "For adversarial posts, treat the source as third-party material unless it is explicitly a Kodus/user update. Identify a common belief or dominant narrative the source implies or states, then push back with a grounded counter-position. Attribute events, postmortems, bugs, benchmarks, and claims to the company/community/source they came from. Do not write as if the author experienced them. The pushback must be defensible and aligned with the author's worldview (provided separately). Do not strawman. Do not be edgy for the sake of it.",
    );
  } else if (contentSource === "changelog" || generationMode === "build_in_public") {
    rules.push(
      "For build-in-public posts, explain what changed, why it mattered, the trade-off behind it, and what the team learned. Keep it candid and concrete.",
    );
  } else if (contentSource === "external" && sourcePerspective !== "owned") {
    rules.push(
      "For external sources such as Hacker News, Reddit, competitor posts, research, news, or third-party postmortems, write as commentary from the author's perspective. Keep ownership clear: the source/company/community had the incident, shipped the product, ran the benchmark, or searched for tools; the author is reacting to it. Avoid 'I/we had this problem', 'our postmortem', 'we shipped', or 'we learned' unless the input explicitly says the author or Kodus did.",
    );
  } else if (contentSource === "blog") {
    rules.push(
      "For blog-based posts, do not just tease the article. Extract one useful opinion, rule of thumb, or lesson from it and make the post stand alone.",
    );
  }

  if (!rules.length) {
    rules.push(
      "Use the source as raw material for a point of view. The post must still be useful without the reader opening a link.",
    );
  }

  return rules.join("\n");
}

function normalizePart(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function outputContract(): string {
  return `Return only a JSON object, no markdown, no commentary.

{
  "posts": [
    {
      "platform": "LinkedIn",
      "variant": 1,
      "hook": "short hook",
      "post": "full post text",
      "cta": "optional CTA",
      "hashtags": []
    }
  ]
}

For each platform in platformConfigs:
- Generate exactly numVariations posts.
- Respect maxLength strictly.
- Adapt formatting to the platform.
- For LinkedIn, return a readable post with short paragraphs separated by blank lines.
- Do not collapse the post into one dense paragraph.
- Include hashtags only when the platform config or instructions explicitly request them.`;
}

function finalFormattingContract(): string {
  return `Formatting must survive the JSON response:
- Keep paragraph breaks in the "post" field.
- Use newline characters inside the JSON string for paragraph breaks.
- Do not return one dense paragraph unless the platform maxLength forces a very short post.
- Preserve readable spacing even when the source attachment is long.`;
}

function taskContract(
  generationMode?: string,
  sourcePerspective?: SocialSourcePerspective,
  narrativeStyle?: SocialNarrativeStyle,
): string {
  if (generationMode === "build_in_public") {
    return `Generate build-in-public social posts about owned work.

Each post should read like a real engineering/product update from the team that shipped something. Ground every detail in baseContent and instructions.

Each variation should naturally cover:
- What happened.
- What changed.
- Why that choice made sense.
- What the team learned or what is next.

Do not use build-in-public framing for third-party material. If sourcePerspective is not "owned", treat the material as observed and explain what the author noticed while reading it.`;
  }

  if (generationMode === "adversarial") {
    return `Generate adversarial social posts that push back against a specific claim, assumption, or dominant narrative.

Each post must:
- Challenge one real claim or assumption a reader would recognize.
- Offer a grounded counter-position aligned with the author's worldview when worldview is present.
- Use baseContent as evidence or context.
- Push back on the idea, not on a person or brand.

Do not use "Hot take:", "unpopular opinion", ragebait, dunking, or contrast scaffolds like "not X, but Y".`;
  }

  if (sourcePerspective === "observed") {
    return `Generate social posts that comment on material the author read or saw.

The post may mention the source naturally when useful, for example "this postmortem shows" or "after reading this". Do not hide the source if hiding it would make the event sound like it happened to the author.

Use the selected narrative style (${narrativeStyle ?? "analysis"}) while keeping ownership clear.`;
  }

  return `Generate standalone content-marketing social posts inspired by the source material.

Use the source to extract useful problems, opinions, lessons, or decision rules for experienced engineering readers. The post should stand on its own, but it must not claim that third-party events happened to the author.

Use the selected narrative style (${narrativeStyle ?? "lesson"}) and make each variation materially different.`;
}

function safetyContract(): string {
  return `Source ownership rules:
- Never turn a third-party outage, postmortem, bug, benchmark, tool search, or company decision into the author's personal story.
- If sourcePerspective is "observed", write as someone reacting to or analyzing the source.
- If sourcePerspective is "inspired", use the source as raw material without pretending the events are owned.
- If sourcePerspective is "owned", first person is allowed only for facts supported by baseContent.

Style rules:
- No em dashes.
- No fake data, metrics, incidents, customer stories, or tools.
- No generic motivational tone.
- No "game changer", "revolutionary", "unlock", "supercharge", "leverage", "seamless", "dive into", or "ever-evolving".
- No rule-of-three lists.
- No contrast framing like "it is not X, it is Y".
- No staccato strings of short dramatic sentences.
- No self-narration like "the key takeaway is" or "here is why this matters".

Anti-AI writing guardrails:
${SOCIAL_ANTI_AI_GUARDRAILS}

Before returning, rewrite any post that sounds like a press release, a LinkedIn coach, or a fake personal anecdote.`;
}

export function buildSocialInstructions({
  instructions,
  contentSource,
  generationMode,
  sourcePerspective,
  narrativeStyle,
  platformConfigs,
}: BuildSocialInstructionsInput): string {
  const parts = [
    `Social writing style:\n${SOCIAL_STYLE_GUIDE}`,
    `Perspective:\n${perspectiveRules(sourcePerspective)}`,
    `Narrative:\n${narrativeRules(narrativeStyle)}`,
    `Source handling:\n${sourceRules(
      contentSource,
      generationMode,
      sourcePerspective,
    )}`,
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

export function buildSocialWriterPrompt({
  baseContent,
  instructions,
  contentSource,
  generationMode,
  sourcePerspective,
  narrativeStyle,
  platformConfigs,
  language,
  tone,
  variationStrategy,
  sourceAttachments,
  voicePolicyPrompt,
  worldview,
}: BuildSocialWriterPromptInput): string {
  const socialInstructions = buildSocialInstructions({
    instructions,
    contentSource,
    generationMode,
    sourcePerspective,
    narrativeStyle,
    platformConfigs,
  });

  const context = {
    generationMode,
    contentSource,
    sourcePerspective,
    narrativeStyle,
    language,
    tone: normalizePart(tone),
    platformConfigs: platformConfigs ?? [],
  };

  const parts = [
    "You are a senior social writer for devtools teams.",
    "The backend has already resolved the writing mode. Follow this prompt as the single source of truth for the n8n AI agent.",
    `Context:\n${JSON.stringify(context, null, 2)}`,
    normalizePart(voicePolicyPrompt)
      ? `Voice policy:\n${normalizePart(voicePolicyPrompt)}`
      : null,
    generationMode === "adversarial" && normalizePart(worldview)
      ? `Author worldview:\n${normalizePart(worldview)}`
      : null,
    `Writing instructions:\n${socialInstructions}`,
    `Task:\n${taskContract(
      generationMode,
      sourcePerspective,
      narrativeStyle,
    )}`,
    `Variation strategy:\n${variationStrategy}`,
    `Base content:\n${baseContent.trim()}`,
    formatSourceAttachmentsForPrompt(sourceAttachments, {
      heading: "Attached sources for this social generation",
    }),
    `Final formatting check:\n${finalFormattingContract()}`,
    `Safety and quality:\n${safetyContract()}`,
    `Output format:\n${outputContract()}`,
  ].filter((part): part is string => Boolean(part));

  return parts.join("\n\n---\n\n");
}
