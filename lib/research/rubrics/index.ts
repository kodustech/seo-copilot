import type { Rubric } from "@/lib/research/types";
import qeKodusV1 from "@/lib/research/rubrics/qe-kodus-v1.json";
import genericB2bV1 from "@/lib/research/rubrics/generic-b2b-v1.json";

const RUBRICS: Record<string, Rubric> = {
  [qeKodusV1.id]: qeKodusV1 as Rubric,
  [genericB2bV1.id]: genericB2bV1 as Rubric,
};

export function listRubrics(): Rubric[] {
  return Object.values(RUBRICS);
}

export function getRubric(id: string): Rubric {
  const rubric = RUBRICS[id];
  if (!rubric) {
    throw new Error(
      `Unknown rubric "${id}". Available: ${Object.keys(RUBRICS).join(", ")}`,
    );
  }
  return rubric;
}

export function getDefaultRubricId(): string {
  return "qe-kodus-v1";
}

const VALID_PACKS = new Set([
  "careers",
  "product",
  "ship",
  "news",
  "pain",
  "firmo",
]);

/**
 * Validate/normalize a rubric coming from outside the static registry
 * (LLM-compiled from a natural-language ICP, or stored per-table JSON).
 * Throws with a readable message when the shape is unusable.
 */
export function validateRubric(input: unknown): Rubric {
  const r = input as Partial<Rubric> | null;
  if (!r || typeof r !== "object") throw new Error("Rubric must be an object");
  if (!r.id || typeof r.id !== "string") throw new Error("Rubric needs an id");
  if (!Array.isArray(r.criteria) || r.criteria.length < 3) {
    throw new Error("Rubric needs at least 3 criteria");
  }

  const seen = new Set<string>();
  const criteria = r.criteria.map((c, i) => {
    if (!c?.id || typeof c.id !== "string") {
      throw new Error(`Criterion ${i} needs an id`);
    }
    const id = c.id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (seen.has(id)) throw new Error(`Duplicate criterion id "${id}"`);
    seen.add(id);
    const kind =
      c.kind === "trigger" || c.kind === "fit" || c.kind === "anti"
        ? c.kind
        : "fit";
    if (!c.pass_hint || typeof c.pass_hint !== "string") {
      throw new Error(`Criterion "${id}" needs a pass_hint`);
    }
    const packs = (Array.isArray(c.packs) ? c.packs : []).filter((p) =>
      VALID_PACKS.has(p),
    );
    return {
      id,
      label: typeof c.label === "string" && c.label ? c.label : id,
      kind,
      weight:
        typeof c.weight === "number" && Number.isFinite(c.weight)
          ? Math.min(Math.max(c.weight, 0), 30)
          : 10,
      packs: packs.length > 0 ? packs : ["careers", "news"],
      pass_hint: c.pass_hint,
      ...(c.veto === true ? { veto: true } : {}),
    };
  });

  const hasScorable = criteria.some(
    (c) => c.kind !== "anti" && c.weight > 0,
  );
  if (!hasScorable) {
    throw new Error("Rubric needs at least one weighted trigger/fit criterion");
  }

  return {
    id: r.id,
    name: typeof r.name === "string" && r.name ? r.name : r.id,
    version: typeof r.version === "number" ? r.version : 1,
    description: typeof r.description === "string" ? r.description : "",
    pass_threshold:
      typeof r.pass_threshold === "number"
        ? Math.min(Math.max(r.pass_threshold, 10), 95)
        : 55,
    default_personas: Array.isArray(r.default_personas)
      ? r.default_personas.filter((p): p is string => typeof p === "string")
      : ["CTO", "Head of Engineering", "Founder"],
    criteria,
  };
}

/** Rubric for a table: custom per-table rubric wins over the built-in reference. */
export function resolveRubric(table: {
  rubricId: string;
  rubricJson?: Rubric | null;
}): Rubric {
  if (table.rubricJson) return validateRubric(table.rubricJson);
  return getRubric(table.rubricId);
}
