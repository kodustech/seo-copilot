import { NextResponse } from "next/server";

import { fetchKeywordsHistory } from "@/lib/copilot";

export async function GET() {
  try {
    const keywords = await fetchKeywordsHistory();
    return NextResponse.json({ keywords });
  } catch (error) {
    console.error("Error fetching history", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch history." },
      { status: 400 },
    );
  }
}
