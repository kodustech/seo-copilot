import { NextResponse } from "next/server";
import { syncLLMMentionsSnapshot } from "@/lib/dataforseo";

export const maxDuration = 120;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const snapshots = await syncLLMMentionsSnapshot();
    return NextResponse.json({
      synced: snapshots.length,
      platforms: snapshots.map((s) => s.platform),
    });
  } catch (err) {
    console.error("[cron/llm-mentions] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
