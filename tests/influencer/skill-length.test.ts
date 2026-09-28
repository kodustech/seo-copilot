import { describe, expect, it } from "vitest";

import {
  addSkill,
  MAX_SKILL_LENGTH,
  SkillValidationError,
  updateSkill,
} from "../../lib/influencer/feedback";
import type { SupabaseClient } from "@supabase/supabase-js";

function oversizedRule() {
  return `Rule ${"x".repeat(MAX_SKILL_LENGTH)}`;
}

class FakeQuery implements PromiseLike<{ data: never[]; error: null }> {
  updated: Record<string, unknown> | undefined;

  constructor(private readonly content: string) {}

  select() { return this; }
  eq() { return this; }
  contains() { return this; }
  maybeSingle() { return Promise.resolve({ data: { content: this.content }, error: null }); }
  update(values: Record<string, unknown>) {
    this.updated = values;
    return this;
  }
  then<TResult1 = { data: never[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: never[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: [], error: null }).then(onfulfilled, onrejected);
  }
}

describe("influencer skill length", () => {
  it("rejects oversized new rules instead of storing a truncated prefix", async () => {
    await expect(
      addSkill({} as SupabaseClient, "persona-1", oversizedRule(), "operator"),
    ).rejects.toBeInstanceOf(SkillValidationError);
  });

  it("allows changing the source of a legacy oversized rule without rewriting its text", async () => {
    const content = oversizedRule();
    const query = new FakeQuery(content);
    const client = { from: () => query } as unknown as SupabaseClient;

    await expect(updateSkill(client, "persona-1", "skill-1", content, "operator")).resolves.toBeUndefined();
    expect(query.updated).toEqual({ tags: ["skill", "operator"] });
  });

  it("rejects editing the content of a legacy oversized rule", async () => {
    const content = oversizedRule();
    const query = new FakeQuery(content);
    const client = { from: () => query } as unknown as SupabaseClient;

    await expect(
      updateSkill(client, "persona-1", "skill-1", `${content} changed`, "operator"),
    ).rejects.toBeInstanceOf(SkillValidationError);
    expect(query.updated).toBeUndefined();
  });
});
