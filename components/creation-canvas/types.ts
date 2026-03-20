import type {
  KeywordSuggestion,
  TitleIdea,
  ArticlePost,
  SocialPostVariation,
} from "@/lib/types";
import type { IdeaResult } from "@/lib/exa";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type StepStatus = "idle" | "loading" | "done" | "error";

// ---------------------------------------------------------------------------
// Clarification
// ---------------------------------------------------------------------------

export type ClarifyQuestion = {
  id: string;
  question: string;
  options: string[];
};

export type ClarifyData = {
  questions: ClarifyQuestion[];
  answers: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Step data types
// ---------------------------------------------------------------------------

export type OutlineSection = { heading: string; bullets: string[] };
export type OutlineData = { sections: OutlineSection[] };
export type ArticleData = { article: ArticlePost };
export type SocialData = { variations: SocialPostVariation[] };

export type PipelineStepKind = "outline" | "article" | "social";

export type PipelineStep = {
  kind: PipelineStepKind;
  status: StepStatus;
  data: OutlineData | ArticleData | SocialData | null;
  error?: string;
};

// ---------------------------------------------------------------------------
// Keyword + Title pair
// ---------------------------------------------------------------------------

export type KTPair = {
  id: string;
  keyword: KeywordSuggestion;
  title: TitleIdea;
  estimated?: boolean; // volume/KD are AI estimates, not real data
};

// ---------------------------------------------------------------------------
// Sub-pipeline — one per advanced KT pair
// ---------------------------------------------------------------------------

export type SubPipeline = {
  id: string; // same as KTPair id
  pair: KTPair;
  steps: PipelineStep[];
};

// ---------------------------------------------------------------------------
// Branch — one per selected idea
// ---------------------------------------------------------------------------

export type Branch = {
  id: string;
  idea: IdeaResult;
  groupStatus: StepStatus;
  groupError?: string;
  pairs: KTPair[]; // 3 keyword+title combos
  pipelines: SubPipeline[]; // one per "Advanced" pair
};

// ---------------------------------------------------------------------------
// Pipeline state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sticky notes
// ---------------------------------------------------------------------------

export type StickyNote = {
  id: string;
  text: string;
  position: { x: number; y: number };
  color: "amber" | "blue" | "green" | "pink";
};

export type StickyEdge = {
  noteId: string;
  targetNodeId: string;
};

export type ContentMode = "blog" | "social";
export type TrunkPhase = "triage" | "clarify" | "ideas";

export type PipelineState = {
  topic: string;
  mode: ContentMode;
  phase: TrunkPhase;
  trunkStatus: StepStatus;
  ideas: IdeaResult[];
  clarify: ClarifyData | null;
  trunkError?: string;
  branches: Branch[];
  /** Free-form sticky notes on the canvas */
  stickyNotes: StickyNote[];
  /** Connections from sticky notes to pipeline nodes */
  stickyEdges: StickyEdge[];
};

// ---------------------------------------------------------------------------
// Reducer actions
// ---------------------------------------------------------------------------

export type PipelineAction =
  | { type: "START_PIPELINE"; topic: string; mode: ContentMode }
  | { type: "NEEDS_CLARIFY"; questions: ClarifyQuestion[] }
  | { type: "ANSWER_QUESTION"; questionId: string; answer: string }
  | { type: "SUBMIT_ANSWERS" }
  | { type: "SKIP_TO_IDEAS" }
  | { type: "SET_IDEAS"; ideas: IdeaResult[] }
  | { type: "SET_TRUNK_ERROR"; error: string }
  | { type: "SET_TRUNK_LOADING" }
  // Branch
  | { type: "ADD_BRANCH"; idea: IdeaResult }
  | { type: "REMOVE_BRANCH"; branchId: string }
  | { type: "SET_BRANCH_PAIRS"; branchId: string; pairs: KTPair[] }
  | { type: "SET_BRANCH_ERROR"; branchId: string; error: string }
  | { type: "SHUFFLE_PAIR"; branchId: string; pairIndex: number }
  | { type: "UPDATE_PAIR"; branchId: string; pairIndex: number; pair: KTPair }
  // Sub-pipeline
  | { type: "ADVANCE_PAIR"; branchId: string; pair: KTPair }
  | { type: "SET_PIPELINE_STEP_DATA"; branchId: string; pipelineId: string; stepIndex: number; data: OutlineData | ArticleData | SocialData }
  | { type: "SET_PIPELINE_STEP_ERROR"; branchId: string; pipelineId: string; stepIndex: number; error: string }
  | { type: "SET_PIPELINE_STEP_LOADING"; branchId: string; pipelineId: string; stepIndex: number }
  | { type: "ADD_PIPELINE_STEP"; branchId: string; pipelineId: string; kind: PipelineStepKind }
  | { type: "TRUNCATE_PIPELINE"; branchId: string; pipelineId: string; fromStepIndex: number }
  // Sticky notes
  | { type: "ADD_STICKY"; note: StickyNote }
  | { type: "UPDATE_STICKY"; noteId: string; text: string }
  | { type: "MOVE_STICKY"; noteId: string; position: { x: number; y: number } }
  | { type: "DELETE_STICKY"; noteId: string }
  | { type: "ADD_STICKY_EDGE"; noteId: string; targetNodeId: string }
  | { type: "DELETE_STICKY_EDGE"; noteId: string; targetNodeId: string };
