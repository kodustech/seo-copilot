import { NextResponse } from "next/server";

import {
  pushRowToCrm,
  pushRowToOutreach,
} from "@/lib/research/actions";
import { runAiColumn } from "@/lib/research/ai-column";
import { enrichPeopleForRow } from "@/lib/research/waterfall";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    switch (action) {
      case "crm": {
        const result = await pushRowToCrm(client, id);
        return NextResponse.json(result);
      }
      case "outreach": {
        const result = await pushRowToOutreach(client, id, {
          createdByEmail: userEmail,
        });
        return NextResponse.json(result);
      }
      case "people": {
        const people = await enrichPeopleForRow(client, id, {
          onlyIfPass: body.onlyIfPass === true,
        });
        return NextResponse.json({ people });
      }
      case "ai_column": {
        if (!body.prompt || typeof body.prompt !== "string") {
          return NextResponse.json(
            { error: "prompt required" },
            { status: 400 },
          );
        }
        const result = await runAiColumn(client, id, body.prompt);
        return NextResponse.json(result);
      }
      case "qualify": {
        // people (if pass or forced) → CRM + outreach
        await enrichPeopleForRow(client, id, {
          onlyIfPass: body.force !== true,
        });
        const crm = await pushRowToCrm(client, id);
        const outreach = await pushRowToOutreach(client, id, {
          createdByEmail: userEmail,
        });
        return NextResponse.json({ crm, outreach });
      }
      default:
        return NextResponse.json(
          {
            error:
              "action must be crm | outreach | people | ai_column | qualify",
          },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
