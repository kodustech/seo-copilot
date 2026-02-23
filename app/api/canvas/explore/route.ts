import { NextResponse } from "next/server";

import { searchIdeas, searchCompetitorContent } from "@/lib/exa";
import {
  enqueueKeywordTask,
  fetchKeywordTaskResult,
  fetchTitlesFromCopilot,
  enqueueArticleTask,
  fetchArticleTaskResult,
} from "@/lib/copilot";
import { resolveVoicePolicyForRequest } from "@/lib/voice-policy";

type ExploreBody = {
  action:
    | "explore"
    | "keywords"
    | "keywords_status"
    | "titles"
    | "article"
    | "article_status"
    | "competitors";
  topic?: string;
  idea?: string;
  taskId?: number;
  keywords?: { keyword: string }[];
  title?: string;
  keyword?: string;
  useResearch?: boolean;
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
