import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { listSkills } from "../../lib/influencer/feedback";

function skillClient(operatorCount: number, repeatFirstPage = false) {
  const rows = Array.from({ length: operatorCount }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    content: `Rule ${i}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  const cursors: { createdAt: string; id: string }[] = [];
  const client = {
    from: () => {
      let timestamp: string | null = null;
      let idCursor: string | null = null;
      let olderThan: string | null = null;
      const query = {
        select: () => query,
        eq: (column: string, value: string) => {
          if (column === "created_at") timestamp = value;
          return query;
        },
        contains: () => query,
        not: () => query,
        order: () => query,
        limit: (limit: number) => {
          pageLimit = limit;
          return query;
        },
        lt: (column: string, value: string) => {
          if (column === "id") idCursor = value;
          if (column === "created_at") olderThan = value;
          if (timestamp) cursors.push({ createdAt: timestamp, id: value });
          return query;
        },
        then: (resolve: (value: { data: typeof rows; error: null }) => unknown) => {
          let eligible = rows;
          if (!repeatFirstPage) {
            if (timestamp && idCursor) {
              eligible = rows.filter((row) => row.created_at === timestamp && row.id < idCursor!);
            } else if (olderThan) {
              eligible = rows.filter((row) => row.created_at < olderThan!);
            }
          }
          eligible = [...eligible].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
          return Promise.resolve({
            data: eligible.slice(0, pageLimit),
            error: null,
          }).then(resolve);
        },
      };
      let pageLimit = 200;
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, cursors };
}

describe("operator skill pagination", () => {
  it("includes every operator rule across keyset pages", async () => {
    const { client, cursors } = skillClient(205);
    const skills = await listSkills(client, "persona-1");
    expect(skills.operator).toHaveLength(205);
    expect(skills.operator.at(-1)).toBe("Rule 0");
    expect(cursors.length).toBeGreaterThan(0);
  });

  it("stops with an error if a broken cursor returns the first page again", async () => {
    const { client, cursors } = skillClient(205, true);
    await expect(listSkills(client, "persona-1")).rejects.toThrow("Operator skill pagination did not advance.");
    expect(cursors.length).toBeGreaterThan(0);
  });

  it("keeps the newest operator rules when applying the prompt cap", async () => {
    const { client } = skillClient(605);
    const skills = await listSkills(client, "persona-1");
    expect(skills.operator).toHaveLength(500);
    expect(skills.operator[0]).toBe("Rule 604");
    expect(skills.operator.at(-1)).toBe("Rule 105");
  });
});
