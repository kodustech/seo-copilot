import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { listSkills } from "../../lib/influencer/feedback";

function skillClient(operatorCount: number, repeatFirstPage = false) {
  const rows = Array.from({ length: operatorCount }, (_, i) => ({
    id: `skill-${String(i).padStart(4, "0")}`,
    content: `Rule ${i}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  })).reverse();
  const cursors: string[] = [];
  const client = {
    from: () => {
      let cursor: { created_at: string; id: string } | null = null;
      const query = {
        select: () => query,
        eq: () => query,
        contains: () => query,
        not: () => query,
        order: () => query,
        limit: () => Promise.resolve({ data: [], error: null }),
        or: (filter: string) => {
          const match = filter.match(/created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)/);
          if (match) cursor = { created_at: match[2], id: match[3] };
          cursors.push(filter);
          return query;
        },
        then: (resolve: (value: { data: typeof rows; error: null }) => unknown) => {
          const eligible = repeatFirstPage || !cursor
            ? rows
            : rows.filter((row) => row.created_at < cursor!.created_at ||
              (row.created_at === cursor!.created_at && row.id < cursor!.id));
          return Promise.resolve({
            data: eligible.slice(0, 200),
            error: null,
          }).then(resolve);
        },
      };
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
    expect(cursors).toHaveLength(1);
  });

  it("stops with an error if a broken cursor returns the first page again", async () => {
    const { client, cursors } = skillClient(205, true);
    await expect(listSkills(client, "persona-1")).rejects.toThrow("Operator skill pagination did not advance.");
    expect(cursors).toHaveLength(1);
  });
});
