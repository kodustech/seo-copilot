import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  listGoalLinks,
  recalculateGoalProgress,
  removeGoalLink,
} from "@/lib/goals";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; workItemId: string }> },
) {
  const { id: goalId, workItemId } = await params;
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    await removeGoalLink(client, goalId, workItemId);
    const goal = await recalculateGoalProgress(client, goalId);
    const links = await listGoalLinks(client, goalId);
    return NextResponse.json({ goal, links });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to unlink" },
      { status: 500 },
    );
  }
}
