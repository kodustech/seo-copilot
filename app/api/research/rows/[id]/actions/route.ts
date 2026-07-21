import { NextResponse } from "next/server";

import {
  pushRowToCrm,
  pushRowToOutreach,
} from "@/lib/research/actions";
import { runAiColumn } from "@/lib/research/ai-column";
import { setCell } from "@/lib/research/columns";
import {
  getRow,
  listPeople,
} from "@/lib/research/tables";
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
      case "upsert_people": {
        // Manual edit: MERGE by default (never silent wipe). Pass replace:true for full replace.
        // Body: { people: [{ name, role?, email?, linkedin? }, ...], replace?: boolean }
        const row = await getRow(client, id);
        if (!row) {
          return NextResponse.json({ error: "Row not found" }, { status: 404 });
        }
        let peopleInput = Array.isArray(body.people) ? body.people : null;
        if (!peopleInput && typeof body.name === "string" && body.name.trim()) {
          peopleInput = [
            {
              name: body.name,
              role: body.role ?? null,
              email: body.email ?? null,
              linkedin: body.linkedin ?? null,
            },
          ];
        }
        if (!peopleInput || peopleInput.length === 0) {
          return NextResponse.json(
            { error: "people[] or name required" },
            { status: 400 },
          );
        }
        const cleaned = peopleInput
          .map(
            (p: {
              name?: string;
              role?: string | null;
              email?: string | null;
              linkedin?: string | null;
            }) => ({
              name: String(p.name ?? "").trim(),
              role: p.role ? String(p.role).trim() : null,
              email: p.email ? String(p.email).trim() : null,
              linkedin: p.linkedin ? String(p.linkedin).trim() : null,
              emailSource: "manual" as const,
              providerUsed: "manual",
              confidence: 1,
            }),
          )
          .filter((p: { name: string }) => p.name.length > 0);
        if (cleaned.length === 0) {
          return NextResponse.json(
            { error: "At least one person with name is required" },
            { status: 400 },
          );
        }
        const { savePeople } = await import("@/lib/research/tables");
        await savePeople(client, id, cleaned, {
          mode: body.replace === true ? "replace" : "merge",
          reason: body.replace === true ? "api_replace" : "api_merge",
          createdBy: userEmail,
        });
        // Keep contact_linkedin cell in sync if that column exists
        const top = cleaned.find((p: { linkedin: string | null }) => p.linkedin) ?? cleaned[0];
        if (top.linkedin) {
          try {
            await setCell(client, id, "contact_linkedin", top.linkedin, {
              status: "done",
              evidence: `Manual: ${top.name}${top.role ? ` (${top.role})` : ""}`,
            });
          } catch {
            // column may not exist — ignore
          }
        }
        const people = await listPeople(client, id);
        return NextResponse.json({ people, ok: true });
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
        // people (if pass or forced) → Accounts (CRM) — single Convert system of record
        await enrichPeopleForRow(client, id, {
          onlyIfPass: body.force !== true,
        });
        const crm = await pushRowToCrm(client, id);
        return NextResponse.json({ crm, accounts: crm });
      }
      default:
        return NextResponse.json(
          {
            error:
              "action must be crm | outreach | people | upsert_people | ai_column | qualify",
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
