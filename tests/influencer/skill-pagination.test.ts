import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { listSkills } from "../../lib/influencer/feedback";

function skillClient(operatorCount: number, repeatFirstPage = false) {
  const rows = Array.from({ length: operatorCount }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    content: `Rule ${i}`,
  }));
  const cursors: (string | null)[] = [];
  const client = {
    from: () => {
      let cursor: string | null = null;
      const query = {
        select: () => query,
        eq: () => query,
        contains: () => query,
        not: () => query,
        order: () => query,
        limit: () => query,
        gt: (_column: string, value: string) => {
          cursor = value;
          cursors.push(value);
          return query;
        },
        then: (resolve: (value: { data: typeof rows; error: null }) => unknown) => {
          const eligible = repeatFirstPage || !cursor
            ? rows
            : rows.filter((row) => row.id > cursor!);
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
    expect(skills.operator.at(-1)).toBe("Rule 204");
    expect(cursors).toHaveLength(1);
  });

  it("stops with an error if a broken cursor returns the first page again", async () => {
    const { client, cursors } = skillClient(205, true);
    await expect(listSkills(client, "persona-1")).rejects.toThrow("Operator skill pagination did not advance.");
    expect(cursors).toHaveLength(1);
  });
});
