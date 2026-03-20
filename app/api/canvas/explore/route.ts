import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";

import { searchIdeas, searchCompetitorContent } from "@/lib/exa";
import {
  enqueueKeywordTask,
  fetchKeywordTaskResult,
  fetchTitlesFromCopilot,
  enqueueArticleTask,
  fetchArticleTaskResult,
  generateSocialContent,
} from "@/lib/copilot";
import { resolveVoicePolicyForRequest } from "@/lib/voice-policy";
import { getModel } from "@/lib/ai/provider";
import { fetchKeywordVolumes } from "@/lib/dataforseo";

type ExploreBody = {
  action:
    | "explore"
    | "keywords"
    | "keywords_status"
    | "titles"
    | "article"
    | "article_status"
    | "competitors"
    | "outline"
    | "social"
    | "keyword-title-ai"
    | "explore-ideas"
    | "triage"
    | "refresh-volume";
  topic?: string;
  idea?: string;
  answers?: Record<string, string>;
  taskId?: number;
  keywords?: { keyword: string }[];
  title?: string;
  keyword?: string;
  useResearch?: boolean;
  baseContent?: string;
  context?: string; // original user prompt, passed through the pipeline
};

export async function POST(request: Request) {
  let body: ExploreBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const { action } = body;

  try {
    if (action === "triage") {
      if (!body.topic?.trim()) {
        return NextResponse.json(
          { error: "Provide a topic." },
          { status: 400 },
        );
      }

      const triageSchema = z.object({
        needsClarification: z.boolean().describe("True if the topic is too vague and you need more context to generate good content ideas"),
        questions: z
          .array(
            z.object({
              id: z.string(),
              question: z.string().describe("Short clarifying question"),
              options: z
                .array(z.string())
                .describe("2-4 suggested answers the user can pick from"),
            }),
          )
          .describe("1-3 clarifying questions, only if needsClarification is true"),
        refinedTopic: z
          .string()
          .describe("If no clarification needed, a refined/expanded version of the topic for better research"),
      });

      // If answers are provided, incorporate them
      const answersContext = body.answers
        ? Object.entries(body.answers)
            .map(([q, a]) => `Q: ${q}\nA: ${a}`)
            .join("\n\n")
        : "";

      const { object } = await generateObject({
        model: getModel(),
        schema: triageSchema,
        prompt: `You are a content strategist helping a user plan blog content. Evaluate if the given topic has enough context to generate strong, targeted content ideas.

Topic: "${body.topic.trim()}"
${answersContext ? `\nUser already answered:\n${answersContext}` : ""}

Rules:
- If the topic is specific enough (e.g. "how to set up preview environments with Vercel"), set needsClarification=false and provide a refinedTopic
- If the topic is vague (e.g. "AI", "testing", "devops"), set needsClarification=true and ask 1-3 SHORT questions
- Questions should help narrow: target audience, specific angle, experience level, tech stack, or goal
- Each question must have 2-4 clickable options for fast answers
- If the user already provided answers, use them to decide if you have enough context now
- Respond in the same language as the topic
- Be concise — questions should be one sentence max`,
      });

      return NextResponse.json(object);
    }

    if (action === "explore") {
      if (!body.topic?.trim()) {
        return NextResponse.json(
          { error: "Provide a topic to explore." },
          { status: 400 },
        );
      }
      const result = await searchIdeas({ topic: body.topic.trim() });
      return NextResponse.json(result);
    }

    if (action === "explore-ideas") {
      if (!body.topic?.trim()) {
        return NextResponse.json(
          { error: "Provide a topic to explore." },
          { status: 400 },
        );
      }

      // Step 1: Exa research — real pain points, questions, trends from communities
      const research = await searchIdeas({ topic: body.topic.trim() });
      const rawIdeas = research.results ?? [];

      // Step 2: LLM synthesizes original content ideas based on the research
      const ideasSchema = z.object({
        ideas: z.array(
          z.object({
            title: z.string().describe("Original content idea title — NOT a copy of an existing post"),
            angle: z.enum(["pain_points", "questions", "trends", "comparisons", "best_practices"]),
            angleLabel: z.string().describe("Human-readable angle label"),
            summary: z.string().describe("2-3 sentence description of what this content would cover and why it would resonate"),
            inspiration: z.string().describe("Brief note on what community signal inspired this idea"),
          }),
        ),
      });

      const researchContext = rawIdeas
        .slice(0, 15)
        .map((r) => `[${r.angleLabel} | ${r.source}] ${r.title}${r.summary ? ` — ${r.summary}` : ""}`)
        .join("\n");

      const { object } = await generateObject({
        model: getModel(),
        schema: ideasSchema,
        prompt: `You are a senior content strategist. Based on real community signals (pain points, questions, trends, comparisons, best practices), generate 8 original content ideas.

Topic: ${body.topic.trim()}
${body.context ? `\nUser direction & notes:\n${body.context}` : ""}

Community research (real posts from Reddit, dev.to, HackerNews, etc.):
${researchContext}

Requirements:
- Generate 8 ORIGINAL content ideas — do NOT copy existing post titles
- Each idea should be a unique angle that would make a great blog post
- Ideas should be inspired by the research but bring a fresh perspective
- Mix different angles (pain points, how-to guides, comparisons, trend analysis, best practices)
- Write in the same language as the topic
- Make titles specific and actionable, not generic
- The summary should explain WHY this content would resonate with the target audience
${body.context ? "- Ideas MUST align with the user's direction and notes above — prioritize those angles" : ""}`,
      });

      const ideas = object.ideas.map((idea, i) => ({
        id: `idea-${i}`,
        title: idea.title,
        url: "",
        source: "AI Research",
        publishedDate: null,
        summary: idea.summary,
        highlights: [idea.inspiration],
        angle: idea.angle,
        angleLabel: idea.angleLabel,
        score: null,
      }));

      return NextResponse.json({ results: ideas, topic: body.topic.trim() });
    }

    if (action === "keywords") {
      if (!body.idea?.trim()) {
        return NextResponse.json(
          { error: "Provide an idea to generate keywords." },
          { status: 400 },
        );
      }
      const voicePolicy = await resolveVoicePolicyForRequest(
        request.headers.get("authorization"),
      );
      const result = await enqueueKeywordTask({
        idea: body.idea.trim(),
        voicePolicy,
      });
      return NextResponse.json(result);
    }

    if (action === "keywords_status") {
      const taskId = Number(body.taskId);
      if (!Number.isFinite(taskId)) {
        return NextResponse.json(
          { error: "Invalid task." },
          { status: 400 },
        );
      }
      const result = await fetchKeywordTaskResult(taskId);
      return NextResponse.json(result);
    }

    if (action === "titles") {
      if (!Array.isArray(body.keywords) || body.keywords.length === 0) {
        return NextResponse.json(
          { error: "Provide keywords to generate titles." },
          { status: 400 },
        );
      }
      const voicePolicy = await resolveVoicePolicyForRequest(
        request.headers.get("authorization"),
      );
      const result = await fetchTitlesFromCopilot({
        keywords: body.keywords,
        voicePolicy,
      });
      return NextResponse.json(result);
    }

    if (action === "article") {
      if (!body.title?.trim() || !body.keyword?.trim()) {
        return NextResponse.json(
          { error: "Provide a title and keyword to generate the article." },
          { status: 400 },
        );
      }
      const voicePolicy = await resolveVoicePolicyForRequest(
        request.headers.get("authorization"),
      );
      const result = await enqueueArticleTask({
        title: body.title.trim(),
        keyword: body.keyword.trim(),
        useResearch: body.useResearch !== false,
        voicePolicy,
      });
      return NextResponse.json(result);
    }

    if (action === "article_status") {
      const taskId = Number(body.taskId);
      if (!Number.isFinite(taskId)) {
        return NextResponse.json(
          { error: "Invalid task." },
          { status: 400 },
        );
      }
      const result = await fetchArticleTaskResult(taskId);
      return NextResponse.json(result);
    }

    if (action === "competitors") {
      if (!body.topic?.trim()) {
        return NextResponse.json(
          { error: "Provide a topic for competitor analysis." },
          { status: 400 },
        );
      }
      const result = await searchCompetitorContent({
        topic: body.topic.trim(),
      });
      return NextResponse.json(result);
    }

    if (action === "keyword-title-ai") {
      if (!body.idea?.trim()) {
        return NextResponse.json(
          { error: "Provide an idea to generate keyword and title." },
          { status: 400 },
        );
      }

      const ktSchema = z.object({
        keywords: z
          .array(z.string().describe("SEO keyword phrase"))
          .describe("5-8 SEO keyword suggestions, long-tail preferred"),
        titles: z.array(
          z.object({
            text: z.string().describe("Blog post title optimized for the keyword"),
            targetKeyword: z.string().describe("Which keyword this title targets"),
          }),
        ).describe("3 compelling blog post titles"),
      });

      // Step 1: AI generates keyword phrases + titles
      const { object } = await generateObject({
        model: getModel(),
        schema: ktSchema,
        prompt: `You are a senior SEO strategist. Given this content idea, generate keyword and title suggestions.
${body.context ? `\nOriginal user direction: "${body.context}"` : ""}
Idea: ${body.idea.trim()}

Requirements:
- Generate 5-8 SEO keywords relevant to this idea (long-tail preferred)
${body.context ? "- Keywords and titles MUST align with the user's original direction/intent above" : ""}
- Generate 3 compelling blog post titles optimized for the top keywords
- Titles should be click-worthy and SEO-friendly
- Write in the same language as the idea
- Focus on keywords with realistic ranking potential`,
      });

      // Step 2: Enrich with real search volumes from DataForSEO
      let volumeMap: Record<string, { volume: number; cpc: number; competition_index: number }> = {};
      try {
        const volumes = await fetchKeywordVolumes(object.keywords);
        for (const v of volumes) {
          volumeMap[v.keyword.toLowerCase()] = {
            volume: v.search_volume ?? 0,
            cpc: v.cpc ?? 0,
            competition_index: v.competition_index ?? 0,
          };
        }
      } catch {
        // DataForSEO unavailable — continue with zero volumes
      }

      const keywords = object.keywords.map((phrase, i) => {
        const vol = volumeMap[phrase.toLowerCase()];
        return {
          id: `kw-${i}`,
          phrase,
          volume: vol?.volume ?? 0,
          cpc: vol?.cpc ?? 0,
          difficulty: vol?.competition_index ?? 0,
        };
      });

      // Sort by volume desc
      keywords.sort((a, b) => b.volume - a.volume);

      const titles = object.titles.map((t, i) => ({
        id: `title-${i}`,
        text: t.text,
        keywords: [t.targetKeyword],
      }));

      return NextResponse.json({ keywords, titles });
    }

    if (action === "outline") {
      if (!body.title?.trim() || !body.keyword?.trim()) {
        return NextResponse.json(
          { error: "Provide a title and keyword to generate the outline." },
          { status: 400 },
        );
      }

      const outlineSchema = z.object({
        sections: z.array(
          z.object({
            heading: z.string().describe("Section heading / H2"),
            bullets: z
              .array(z.string())
              .describe("2-3 key points to cover in this section"),
          }),
        ),
      });

      const { object } = await generateObject({
        model: getModel(),
        schema: outlineSchema,
        prompt: `You are a senior SEO content strategist. Generate a detailed blog post outline for the following:
${body.context ? `\nOriginal user direction: "${body.context}"` : ""}
Title: ${body.title.trim()}
Target Keyword: ${body.keyword.trim()}

Requirements:
- 5-7 sections (H2 headings)
- Each section should have 2-3 bullet points describing what to cover
- The outline should be optimized for the target keyword
- Write in the same language as the title
- Include an introduction and conclusion section
- Structure for maximum readability and SEO value
${body.context ? "- The outline MUST reflect the user's original direction/angle above" : ""}`,
      });

      return NextResponse.json(object);
    }

    if (action === "social") {
      if (!body.baseContent?.trim()) {
        return NextResponse.json(
          { error: "Provide base content to generate social posts." },
          { status: 400 },
        );
      }

      const voicePolicy = await resolveVoicePolicyForRequest(
        request.headers.get("authorization"),
      );

      const variations = await generateSocialContent({
        baseContent: body.baseContent.trim(),
        instructions: body.context ? `Align with the user's original direction: "${body.context}"` : undefined,
        language: "en",
        platformConfigs: [
          { platform: "linkedin", maxLength: 3000 },
          { platform: "linkedin", maxLength: 3000 },
          { platform: "twitter", maxLength: 280 },
          { platform: "twitter", maxLength: 280 },
          { platform: "twitter", maxLength: 280 },
        ],
        contentSource: "blog",
        generationMode: "content_marketing",
        voicePolicy,
      });

      return NextResponse.json({ variations });
    }

    if (action === "refresh-volume") {
      if (!body.keyword?.trim()) {
        return NextResponse.json(
          { error: "Provide a keyword." },
          { status: 400 },
        );
      }

      const kw = body.keyword.trim();

      // Try DataForSEO first
      try {
        const volumes = await fetchKeywordVolumes([kw]);
        const v = volumes[0];
        if (v && (v.search_volume ?? 0) > 0) {
          return NextResponse.json({
            phrase: kw,
            volume: v.search_volume ?? 0,
            cpc: v.cpc ?? 0,
            difficulty: v.competition_index ?? 0,
            estimated: false,
          });
        }
      } catch {
        // DataForSEO unavailable — fall through to AI estimate
      }

      // Fallback: AI estimate
      try {
        const estSchema = z.object({
          monthlySearchVolume: z.number().describe("Estimated monthly search volume on Google"),
          competitionLevel: z.number().min(0).max(100).describe("Keyword difficulty 0-100"),
        });

        const { object: est } = await generateObject({
          model: getModel(),
          schema: estSchema,
          prompt: `Estimate the monthly Google search volume and keyword difficulty (0-100) for: "${kw}". Be realistic — most long-tail keywords have 50-500 monthly searches.`,
        });

        return NextResponse.json({
          phrase: kw,
          volume: est.monthlySearchVolume,
          cpc: 0,
          difficulty: est.competitionLevel,
          estimated: true,
        });
      } catch {
        return NextResponse.json({
          phrase: kw,
          volume: 0,
          cpc: 0,
          difficulty: 0,
          estimated: true,
        });
      }
    }

    return NextResponse.json(
      { error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (error) {
    console.error(`[canvas/explore] action=${action}`, error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Internal canvas error.",
      },
      { status: 500 },
    );
  }
}
