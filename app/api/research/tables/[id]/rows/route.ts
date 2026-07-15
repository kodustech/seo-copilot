import { NextResponse } from "next/server";

import { normalizeDomain } from "@/lib/crm";
import { addRows } from "@/lib/research/tables";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/** Parse "Name, domain.com" or plain domain lines / CSV-ish paste. */
function parseDomainLines(text: string): Array<{
  companyName: string;
  domain: string | null;
}> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: Array<{ companyName: string; domain: string | null }> = [];
  for (const line of lines) {
    // skip header-ish
    if (/^company/i.test(line) && /domain/i.test(line)) continue;
    const parts = line.split(/[,\t]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const domain = normalizeDomain(parts[parts.length - 1]);
      const companyName = parts.slice(0, -1).join(" ");
      out.push({ companyName: companyName || domain || "Unknown", domain });
    } else {
      const domain = normalizeDomain(parts[0]);
      out.push({
        companyName: domain || parts[0],
        domain,
      });
    }
  }
  return out;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    let rows: Array<{
      companyName: string;
      domain?: string | null;
      source?: string;
    }> = [];

    if (typeof body.text === "string" && body.text.trim()) {
      rows = parseDomainLines(body.text).map((r) => ({
        ...r,
        source: body.source ?? "csv",
      }));
    } else if (Array.isArray(body.rows)) {
      rows = body.rows.map(
        (r: { companyName?: string; domain?: string; source?: string }) => ({
          companyName: r.companyName?.trim() || r.domain || "Unknown",
          domain: r.domain ?? null,
          source: r.source ?? "manual",
        }),
      );
    } else if (body.domain || body.companyName) {
      rows = [
        {
          companyName: body.companyName || body.domain,
          domain: body.domain ?? null,
          source: body.source ?? "manual",
        },
      ];
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Provide text, rows[], or domain" },
        { status: 400 },
      );
    }

    const result = await addRows(client, id, rows);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
