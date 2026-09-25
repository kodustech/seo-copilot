import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { listSkills } from "../../lib/influencer/feedback";

function skillClient(operatorCount: number, repeatFirstPage = false) {
  const rows = Array.from({ length: operatorCount }, (_, i) => ({ id: `skill-${i}`, content: `Rule ${i}` }));
  const offsets: number[] = [];
  const client = {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        contains: () => query,
        not: () => query,
        order: () => query,
        limit: () => Promise.resolve({ data: [], error: null }),
        range: (from: number, to: number) => {
          offsets.push(from);
          return Promise.resolve({
            data: rows.slice(repeatFirstPage ? 0 : from, repeatFirstPage ? to - from + 1 : to + 1),
            error: null,
          });
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, offsets };
}

describe("operator skill pagination", () => {
  it("includes every operator rule across pages without a total cap", async () => {
    const { client, offsets } = skillClient(205);
    const skills = await listSkills(client, "persona-1");
    expect(skills).toHaveLength(205);
    expect(skills.at(-1)).toBe("Rule 204");
    expect(offsets).toEqual([0, 200]);
  });

  it("stops with an error if a broken offset returns the first page again", async () => {
    const { client, offsets } = skillClient(205, true);
    await expect(listSkills(client, "persona-1")).rejects.toThrow("Operator skill pagination did not advance.");
    expect(offsets).toEqual([0, 200]);
  });
});
