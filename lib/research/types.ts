export type CriterionKind = "trigger" | "fit" | "anti";
export type CriterionStatus = "pass" | "fail" | "unknown";
export type RowStatus = "pending" | "researching" | "researched" | "failed";
export type RowSource =
  | "manual"
  | "csv"
  | "discovery"
  | "crm"
  | "social"
  | "icp_signal"
  | "agent";

export type RubricCriterion = {
  id: string;
  label: string;
  kind: CriterionKind;
  weight: number;
  packs: string[];
  pass_hint: string;
  veto?: boolean;
};

export type Rubric = {
  id: string;
  name: string;
  version: number;
  description: string;
  pass_threshold: number;
  default_personas: string[];
  criteria: RubricCriterion[];
};

export type EvidenceSource = {
  url: string;
  pack: string;
  title?: string | null;
};

export type CriterionResult = {
  criterionId: string;
  kind: CriterionKind;
  status: CriterionStatus;
  confidence: number;
  evidence: string | null;
  sources: EvidenceSource[];
  weight: number;
  veto?: boolean;
};

export type PackSnippet = {
  url: string;
  title?: string | null;
  text: string;
};

export type PackOutput = {
  pack: string;
  ok: boolean;
  error?: string;
  snippets: PackSnippet[];
  /** Structured extras (e.g. careers signals) */
  meta?: Record<string, unknown>;
};

export type ScoreResult = {
  criteria: CriterionResult[];
  triggerScore: number;
  fitScore: number;
  icpScore: number;
  antiFlags: string[];
  pass: boolean;
  whyNow: string | null;
};

export type ResearchTable = {
  id: string;
  name: string;
  rubricId: string;
  description: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  rowCount?: number;
};

export type ResearchRow = {
  id: string;
  tableId: string;
  companyName: string;
  domain: string | null;
  source: RowSource | string;
  status: RowStatus | string;
  icpScore: number | null;
  triggerScore: number | null;
  fitScore: number | null;
  antiFlags: string[];
  whyNow: string | null;
  pass: boolean | null;
  packRaw: Record<string, unknown>;
  lastResearchedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchEvidence = {
  id: string;
  rowId: string;
  criterionId: string;
  kind: CriterionKind | string;
  status: CriterionStatus | string;
  confidence: number;
  evidence: string | null;
  sources: EvidenceSource[];
  weight: number;
  createdAt: string;
};

export type ResearchPerson = {
  id: string;
  rowId: string;
  name: string;
  role: string | null;
  linkedin: string | null;
  email: string | null;
  emailStatus: string | null;
  emailSource: string | null;
  providerUsed: string | null;
  confidence: number | null;
  notes: string | null;
  createdAt: string;
};

export type ResearchRun = {
  id: string;
  tableId: string | null;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  summary: Record<string, unknown>;
  lastError: string | null;
  createdBy: string | null;
};
