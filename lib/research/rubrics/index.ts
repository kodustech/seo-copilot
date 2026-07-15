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
