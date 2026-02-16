import { NextResponse } from "next/server";

import { searchIdeas, searchCompetitorContent } from "@/lib/exa";
import {
  enqueueKeywordTask,
  fetchKeywordTaskResult,
  fetchTitlesFromCopilot,
  enqueueArticleTask,
  fetchArticleTaskResult,
} from "@/lib/copilot";

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
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  const { action } = body;

  try {
    if (action === "explore") {
      if (!body.topic?.trim()) {
        return NextResponse.json(
          { error: "Informe um tema para explorar." },
          { status: 400 },
        );
      }
      const result = await searchIdeas({ topic: body.topic.trim() });
      return NextResponse.json(result);
    }

    if (action === "keywords") {
      if (!body.idea?.trim()) {
        return NextResponse.json(
          { error: "Informe uma ideia para gerar keywords." },
          { status: 400 },
        );
      }
      const result = await enqueueKeywordTask({ idea: body.idea.trim() });
      return NextResponse.json(result);
    }

    if (action === "keywords_status") {
      const taskId = Number(body.taskId);
      if (!Number.isFinite(taskId)) {
        return NextResponse.json(
          { error: "Task inválida." },
          { status: 400 },
        );
      }
      const result = await fetchKeywordTaskResult(taskId);
      return NextResponse.json(result);
    }

    if (action === "titles") {
      if (!Array.isArray(body.keywords) || body.keywords.length === 0) {
        return NextResponse.json(
          { error: "Informe keywords para gerar títulos." },
          { status: 400 },
        );
      }
      const result = await fetchTitlesFromCopilot({ keywords: body.keywords });
      return NextResponse.json(result);
    }

    if (action === "article") {
      if (!body.title?.trim() || !body.keyword?.trim()) {
        return NextResponse.json(
          { error: "Informe título e keyword para gerar o artigo." },
          { status: 400 },
        );
      }
      const result = await enqueueArticleTask({
        title: body.title.trim(),
        keyword: body.keyword.trim(),
        useResearch: body.useResearch !== false,
      });
      return NextResponse.json(result);
    }

    if (action === "article_status") {
      const taskId = Number(body.taskId);
      if (!Number.isFinite(taskId)) {
        return NextResponse.json(
          { error: "Task inválida." },
          { status: 400 },
        );
      }
      const result = await fetchArticleTaskResult(taskId);
      return NextResponse.json(result);
    }

    if (action === "competitors") {
      if (!body.topic?.trim()) {
        return NextResponse.json(
          { error: "Informe um tema para análise de concorrência." },
          { status: 400 },
        );
      }
      const result = await searchCompetitorContent({
        topic: body.topic.trim(),
      });
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: `Action desconhecida: ${action}` },
      { status: 400 },
    );
  } catch (error) {
    console.error(`[canvas/explore] action=${action}`, error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Erro interno no canvas.",
      },
      { status: 500 },
    );
  }
}
