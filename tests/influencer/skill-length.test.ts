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
  inserted: Record<string, unknown> | undefined;

  constructor(private readonly content: string) {}

  select() { return this; }
  eq() { return this; }
  contains() { return this; }
  maybeSingle() { return Promise.resolve({ data: { content: this.content }, error: null }); }
  update(values: Record<string, unknown>) {
    this.updated = values;
    return this;
  }
  insert(values: Record<string, unknown>) {
    this.inserted = values;
    return this;
  }
  single() {
    return Promise.resolve({
      data: { id: "skill-1", title: "Rule", content: this.inserted?.content, tags: this.inserted?.tags, created_at: "now" },
      error: null,
    });
  }
  then<TResult1 = { data: never[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: never[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: [{ id: "skill-1" }] as never[], error: null }).then(onfulfilled, onrejected);
  }
}

describe("influencer skill length", () => {
  it("rejects oversized new agent rules instead of storing a truncated prefix", async () => {
    await expect(
      addSkill({} as SupabaseClient, "persona-1", oversizedRule(), "agent"),
    ).rejects.toBeInstanceOf(SkillValidationError);
  });

  it("allows oversized operator rules", async () => {
    const query = new FakeQuery("");
    const client = { from: () => query } as unknown as SupabaseClient;

    await expect(addSkill(client, "persona-1", oversizedRule(), "operator")).resolves.toMatchObject({
      content: oversizedRule(),
    });
    expect(query.inserted?.content).toBe(oversizedRule());
  });

  it("allows editing oversized operator rules", async () => {
    const query = new FakeQuery(oversizedRule());
    const client = { from: () => query } as unknown as SupabaseClient;

    await expect(updateSkill(client, "persona-1", "skill-1", `${oversizedRule()} changed`, "operator"))
      .resolves.toBeUndefined();
    expect(query.updated?.content).toBe(`${oversizedRule()} changed`);
  });

  it("allows changing the source of a legacy oversized rule without rewriting its text", async () => {
    const content = oversizedRule();
    const query = new FakeQuery(content);
    const client = { from: () => query } as unknown as SupabaseClient;

    await expect(updateSkill(client, "persona-1", "skill-1", content, "legacy")).resolves.toBeUndefined();
    expect(query.updated).toEqual({ tags: ["skill", "legacy"] });
  });

  it("rejects editing the content of a legacy oversized rule", async () => {
    const content = oversizedRule();
    const query = new FakeQuery(content);
    const client = { from: () => query } as unknown as SupabaseClient;

    await expect(
      updateSkill(client, "persona-1", "skill-1", `${content} changed`, "agent"),
    ).rejects.toBeInstanceOf(SkillValidationError);
    expect(query.updated).toBeUndefined();
  });
});
