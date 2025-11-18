import { NextResponse } from "next/server";

import { fetchKeywordsHistory } from "@/lib/copilot";

export async function GET() {
  try {
    const keywords = await fetchKeywordsHistory();
    return NextResponse.json({ keywords });
  } catch (error) {
    console.error("Erro ao buscar histórico", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao buscar histórico." },
      { status: 400 },
    );
  }
}
