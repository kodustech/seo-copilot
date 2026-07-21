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
import {
  enrichPeopleForRow,
  fillEmailForPerson,
} from "@/lib/research/waterfall";
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
      case "people_history": {
        const { listPeopleSnapshots, listPeople: listP } = await import(
          "@/lib/research/tables"
        );
        const [current, snapshots] = await Promise.all([
          listP(client, id),
          listPeopleSnapshots(client, id, Number(body.limit) || 20),
        ]);
        return NextResponse.json({
          current_count: current.length,
          current,
          snapshots,
        });
      }
      case "people_restore": {
        const snapshotId = String(body.snapshot_id ?? body.snapshotId ?? "");
        if (!snapshotId) {
          return NextResponse.json(
            { error: "snapshot_id required" },
            { status: 400 },
          );
        }
        const { restorePeopleSnapshot } = await import("@/lib/research/tables");
        const mode =
          body.mode === "merge" || body.mode === "replace"
            ? body.mode
            : "replace";
        const people = await restorePeopleSnapshot(client, id, snapshotId, {
          mode,
          createdBy: userEmail,
        });
        return NextResponse.json({
          ok: true,
          mode,
          people,
          count: people.length,
        });
      }
      case "find_email": {
        // Find + NeverBounce-verify email for one person (or re-verify if present)
        const personId =
          typeof body.personId === "string"
            ? body.personId
            : typeof body.person_id === "string"
              ? body.person_id
              : undefined;
        const personName =
          typeof body.personName === "string"
            ? body.personName
            : typeof body.person_name === "string"
              ? body.person_name
              : typeof body.name === "string"
                ? body.name
                : undefined;
        if (!personId && !personName) {
          return NextResponse.json(
            { error: "personId or personName required" },
            { status: 400 },
          );
        }
        const result = await fillEmailForPerson(client, id, {
          personId,
          personName,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      case "dedupe_people": {
        const { dedupePeopleOnRow } = await import("@/lib/research/tables");
        const result = await dedupePeopleOnRow(client, id, {
          createdBy: userEmail,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      default:
        return NextResponse.json(
          {
            error:
              "action must be crm | outreach | people | upsert_people | ai_column | qualify | people_history | people_restore | find_email | dedupe_people",
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
