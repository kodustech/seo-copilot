import { NextResponse } from "next/server";

import {
  listReadyQueue,
  processDueSequenceTasks,
} from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/** GET — LinkedIn (and email-ready) semi queue */
export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    // promote due scheduled → ready first
    await processDueSequenceTasks(client);
    const url = new URL(req.url);
    const channel = url.searchParams.get("channel") as
      | "email"
      | "linkedin"
      | null;
    const tasks = await listReadyQueue(client, {
      channel: channel ?? "linkedin",
      limit: 100,
    });
    return NextResponse.json({ tasks });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
