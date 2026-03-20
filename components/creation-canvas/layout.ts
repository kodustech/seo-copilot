import type { Node, Edge } from "@xyflow/react";
import type { PipelineState, Branch, PipelineStep, SocialData } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAP_Y = 40;
const BRANCH_SPREAD_X = 500;
const PIPELINE_SPREAD_X = 480;
const SOCIAL_SPREAD_X = 320;
const EDGE_STYLE = { stroke: "rgba(255,255,255,0.08)", strokeWidth: 1.5 };

const PROMPT_W = 400;
const CLARIFY_W = 480;
const IDEAS_W = 520;
const KT_GROUP_W = 440;
const OUTLINE_W = 440;
const ARTICLE_W = 460;
const SOCIAL_W = 280;

const PROMPT_H = 70;
const CLARIFY_H = 350;
const IDEAS_LOADING_H = 180;
const IDEAS_DONE_H = 520;
const KT_GROUP_LOADING_H = 160;
const KT_GROUP_DONE_H = 600;

function pipelineStepWidth(kind: string): number {
  switch (kind) {
    case "outline": return OUTLINE_W;
    case "article": return ARTICLE_W;
    case "social": return SOCIAL_W;
    default: return 400;
  }
}

function pipelineStepHeight(step: PipelineStep): number {
  if (step.status === "loading") return 160;
  if (step.status === "error") return 160;
  switch (step.kind) {
    case "outline": return 480;
    case "article": return 420;
    case "social": return 280;
    default: return 200;
  }
}

// ---------------------------------------------------------------------------
// Derive nodes & edges
// ---------------------------------------------------------------------------

export function deriveNodesAndEdges(state: PipelineState) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  if (!state.topic) return { nodes, edges };

  let y = 0;
  let lastTrunkId = "";

  // --- Prompt ---
  nodes.push({ id: "prompt", type: "prompt", position: { x: -PROMPT_W / 2, y }, data: { topic: state.topic } });
  lastTrunkId = "prompt";
  y += PROMPT_H + GAP_Y;

  // --- Clarify ---
  if (state.phase === "clarify" && state.clarify) {
    nodes.push({
      id: "clarify", type: "clarify", position: { x: -CLARIFY_W / 2, y },
      data: { questions: state.clarify.questions, answers: state.clarify.answers },
    });
    edges.push({ id: "e-prompt-clarify", source: "prompt", target: "clarify", type: "smoothstep", style: EDGE_STYLE });
    lastTrunkId = "clarify";
    y += CLARIFY_H + GAP_Y;
  }

  // --- Triage loading ---
  if (state.phase === "triage" && state.trunkStatus === "loading") {
    nodes.push({
      id: "ideas", type: "ideas", position: { x: -IDEAS_W / 2, y },
      data: { status: "loading", ideas: [], selectedIds: [] },
    });
    edges.push({ id: `e-${lastTrunkId}-ideas`, source: lastTrunkId, target: "ideas", type: "smoothstep", style: EDGE_STYLE });
    return { nodes, edges };
  }

  // --- Ideas ---
  if (state.phase === "ideas") {
    const ideasH = state.trunkStatus === "done" ? IDEAS_DONE_H : IDEAS_LOADING_H;
    nodes.push({
      id: "ideas", type: "ideas", position: { x: -IDEAS_W / 2, y },
      data: { status: state.trunkStatus, ideas: state.ideas, selectedIds: state.branches.map((b) => b.idea.id), error: state.trunkError },
    });
    edges.push({ id: `e-${lastTrunkId}-ideas`, source: lastTrunkId, target: "ideas", type: "smoothstep", style: EDGE_STYLE });
    y += ideasH + GAP_Y;

    // --- Branches (KT groups) ---
    const bc = state.branches.length;
    if (bc > 0) {
      const totalSpread = (bc - 1) * BRANCH_SPREAD_X;
      const startX = -totalSpread / 2;

      state.branches.forEach((branch, bi) => {
        const bx = startX + bi * BRANCH_SPREAD_X;
        const ktGroupH = branch.groupStatus === "done" ? KT_GROUP_DONE_H : KT_GROUP_LOADING_H;
        const ktId = `kt-${branch.id}`;

        nodes.push({
          id: ktId, type: "kt-group", position: { x: bx - KT_GROUP_W / 2, y },
          data: {
            branchId: branch.id,
            groupStatus: branch.groupStatus,
            pairs: branch.pairs,
            advancedIds: branch.pipelines.map((p) => p.id),
            error: branch.groupError,
          },
        });
        edges.push({ id: `e-ideas-${branch.id}`, source: "ideas", target: ktId, type: "smoothstep", style: EDGE_STYLE });

        // --- Sub-pipelines (one per advanced pair) ---
        const pc = branch.pipelines.length;
        if (pc > 0) {
          const pSpread = (pc - 1) * PIPELINE_SPREAD_X;
          const pStartX = bx - pSpread / 2;
          let pipelineY = y + ktGroupH + GAP_Y;

          branch.pipelines.forEach((pipeline, pi) => {
            const px = pStartX + pi * PIPELINE_SPREAD_X;
            let stepY = pipelineY;

            pipeline.steps.forEach((step, si) => {
              if (step.kind === "social") {
                const variations = (step.data as SocialData | null)?.variations ?? [];
                const count = step.status === "loading" ? 5 : Math.max(variations.length, 1);
                const socialSpread = SOCIAL_SPREAD_X;

                for (let j = 0; j < count; j++) {
                  const totalW = (count - 1) * socialSpread;
                  const sx = px - totalW / 2 + j * socialSpread;
                  const nid = `p-${pipeline.id}-social-${j}`;

                  nodes.push({
                    id: nid, type: "social", position: { x: sx - SOCIAL_W / 2, y: stepY },
                    data: { branchId: branch.id, pipelineId: pipeline.id, socialIndex: j, status: step.status, variation: variations[j] ?? null },
                  });

                  if (si > 0) {
                    edges.push({ id: `e-${pipeline.id}-${si - 1}-social-${j}`, source: `p-${pipeline.id}-step-${si - 1}`, target: nid, type: "smoothstep", style: EDGE_STYLE });
                  }
                }
              } else {
                const w = pipelineStepWidth(step.kind);
                const nid = `p-${pipeline.id}-step-${si}`;

                nodes.push({
                  id: nid, type: step.kind, position: { x: px - w / 2, y: stepY },
                  data: { branchId: branch.id, pipelineId: pipeline.id, stepIndex: si, status: step.status, ...(step.data ?? {}), error: step.error },
                });

                if (si === 0) {
                  edges.push({ id: `e-${ktId}-${pipeline.id}`, source: ktId, target: nid, type: "smoothstep", style: EDGE_STYLE });
                } else {
                  edges.push({ id: `e-${pipeline.id}-${si - 1}-${si}`, source: `p-${pipeline.id}-step-${si - 1}`, target: nid, type: "smoothstep", style: EDGE_STYLE });
                }
              }

              stepY += pipelineStepHeight(step) + GAP_Y;
            });
          });
        }
      });
    }
  }

  // --- Sticky notes ---
  for (const sn of state.stickyNotes) {
    nodes.push({
      id: sn.id,
      type: "sticky",
      position: sn.position,
      draggable: true,
      data: {
        noteId: sn.id,
        text: sn.text,
        color: sn.color,
      },
    });
  }

  // --- Sticky edges ---
  for (const se of state.stickyEdges) {
    edges.push({
      id: `se-${se.noteId}-${se.targetNodeId}`,
      source: se.noteId,
      target: se.targetNodeId,
      type: "smoothstep",
      animated: true,
      style: { stroke: "rgba(251,191,36,0.3)", strokeWidth: 1.5, strokeDasharray: "5 5" },
    });
  }

  return { nodes, edges };
}
