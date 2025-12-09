import { NextResponse } from "next/server";

import { generateSocialContent } from "@/lib/copilot";

export async function POST(request: Request) {
  const body = await readBody(request);

  try {
    const variations = await generateSocialContent({
      baseContent: typeof body.baseContent === "string" ? body.baseContent : "",
      instructions:
        typeof body.instructions === "string" ? body.instructions : undefined,
      platform: typeof body.platform === "string" ? body.platform : "LinkedIn",
      language: typeof body.language === "string" ? body.language : "pt-BR",
      tone: typeof body.tone === "string" ? body.tone : undefined,
      variationStrategy:
        typeof body.variationStrategy === "string"
          ? body.variationStrategy
          : undefined,
      maxLength: normalizeNumber(body.maxLength),
      hashtagsPolicy:
        typeof body.hashtagsPolicy === "string" ? body.hashtagsPolicy : undefined,
      linksPolicy:
        typeof body.linksPolicy === "string" ? body.linksPolicy : undefined,
      ctaStyle: typeof body.ctaStyle === "string" ? body.ctaStyle : undefined,
      numVariations: normalizeNumber(body.numVariations),
    });
    return NextResponse.json({ posts: variations });
  } catch (error) {
    console.error("Erro ao gerar posts sociais", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao gerar posts." },
      { status: 400 },
    );
  }
}

async function readBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
