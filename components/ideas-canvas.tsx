"use client";

import { useCallback, useState, useRef } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Search, Sparkles } from "lucide-react";

import type { IdeaResult, IdeaAngle, SearchIdeasOutput } from "@/lib/exa";
import { useFavorites } from "@/lib/use-favorites";
import { TopicNode } from "@/components/canvas/topic-node";
import { AngleNode } from "@/components/canvas/angle-node";
import { IdeaNode } from "@/components/canvas/idea-node";
import { IdeaDetailPanel } from "@/components/canvas/idea-detail-panel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANGLE_RADIUS = 320;
const IDEA_CARD_W = 280;
const IDEA_CARD_H = 160;
const IDEA_GAP = 20;
const IDEA_COLS = 2;
const IDEA_OFFSET = 180; // distance from angle node to first idea row

const ANGLES_ORDER: IdeaAngle[] = [
  "pain_points",
  "questions",
  "trends",
  "comparisons",
  "best_practices",
];

const nodeTypes = {
  topic: TopicNode,
  angle: AngleNode,
  idea: IdeaNode,
};

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function anglePosition(index: number, total: number) {
  const startAngle = -Math.PI / 2; // start from top
  const step = (2 * Math.PI) / total;
  const angle = startAngle + step * index;
  return {
    x: Math.cos(angle) * ANGLE_RADIUS,
    y: Math.sin(angle) * ANGLE_RADIUS,
  };
}

function ideaPosition(parentX: number, parentY: number, index: number) {
  // Lay out ideas in a grid extending outward from the angle node
  const dir = Math.atan2(parentY, parentX); // direction away from center
  const col = index % IDEA_COLS;
  const row = Math.floor(index / IDEA_COLS);

  // Perpendicular offset for columns (spread left/right relative to direction)
  const perpX = -Math.sin(dir);
  const perpY = Math.cos(dir);

  // Along-direction offset for rows
  const alongX = Math.cos(dir);
  const alongY = Math.sin(dir);

  const colOffset = (col - (IDEA_COLS - 1) / 2) * (IDEA_CARD_W + IDEA_GAP);
  const rowOffset = IDEA_OFFSET + row * (IDEA_CARD_H + IDEA_GAP);

  return {
    x: parentX + alongX * rowOffset + perpX * colOffset,
    y: parentY + alongY * rowOffset + perpY * colOffset,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IdeasCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[]);

  const [topicInput, setTopicInput] = useState("");
  const [hasExplored, setHasExplored] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState<IdeaResult | null>(null);

  const { isFavorited, toggleFavorite } = useFavorites();

  // Store all ideas grouped by angle for expand/collapse
  const ideasByAngle = useRef<Record<IdeaAngle, IdeaResult[]>>({
    pain_points: [],
    questions: [],
    trends: [],
    comparisons: [],
    best_practices: [],
  });
  const expandedAngles = useRef<Set<IdeaAngle>>(new Set());

  // -------------------------------------------------------------------------
  // Explore topic
  // -------------------------------------------------------------------------

  const handleExplore = useCallback(
    async (topic: string) => {
      if (!topic.trim()) return;

      setHasExplored(true);

      // Create topic node in loading state
      const topicNode: Node = {
        id: "topic",
        type: "topic",
        position: { x: 0, y: 0 },
        data: { label: topic, status: "loading" },
      };
      setNodes([topicNode]);
      setEdges([]);

      try {
        const res = await fetch("/api/canvas/explore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "explore", topic }),
        });
        const data: SearchIdeasOutput = await res.json();

        if (!res.ok) throw new Error((data as unknown as { error: string }).error);

        // Group results by angle
        const grouped: Record<IdeaAngle, IdeaResult[]> = {
          pain_points: [],
          questions: [],
          trends: [],
          comparisons: [],
          best_practices: [],
        };
        for (const r of data.results) {
          if (grouped[r.angle]) grouped[r.angle].push(r);
        }
        ideasByAngle.current = grouped;
        expandedAngles.current = new Set();

        // Build angle nodes
        const newNodes: Node[] = [
          {
            id: "topic",
            type: "topic",
            position: { x: 0, y: 0 },
            data: { label: topic, status: "done" },
          },
        ];
        const newEdges: Edge[] = [];

        ANGLES_ORDER.forEach((angle, i) => {
          const pos = anglePosition(i, ANGLES_ORDER.length);
          const ideas = grouped[angle];
          const angleLabel =
            ideas[0]?.angleLabel ??
            angle.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

          newNodes.push({
            id: `angle-${angle}`,
            type: "angle",
            position: pos,
            data: {
              angle,
              label: angleLabel,
              count: ideas.length,
              expanded: false,
              onToggle: () => toggleAngle(angle),
            },
          });

          newEdges.push({
            id: `edge-topic-${angle}`,
            source: "topic",
            target: `angle-${angle}`,
            type: "smoothstep",
            style: { stroke: "rgba(255,255,255,0.08)", strokeWidth: 1.5 },
          });
        });

        setNodes(newNodes);
        setEdges(newEdges);
      } catch {
        setNodes([
          {
            id: "topic",
            type: "topic",
            position: { x: 0, y: 0 },
            data: { label: topic, status: "error", onExplore: () => handleExplore(topic) },
          },
        ]);
      }
    },
    [setNodes, setEdges],
  );

  // -------------------------------------------------------------------------
  // Toggle angle expansion
  // -------------------------------------------------------------------------

  const toggleAngle = useCallback(
    (angle: IdeaAngle) => {
      const wasExpanded = expandedAngles.current.has(angle);

      if (wasExpanded) {
        expandedAngles.current.delete(angle);
      } else {
        expandedAngles.current.add(angle);
      }

      setNodes((currentNodes) => {
        // Remove all idea nodes for this angle
        let filtered = currentNodes.filter(
          (n) => !(n.type === "idea" && (n.data as { angle?: string }).angle === angle),
        );

        // Update the angle node expanded state
        filtered = filtered.map((n) => {
          if (n.id === `angle-${angle}`) {
            return {
              ...n,
              data: {
                ...n.data,
                expanded: !wasExpanded,
                onToggle: () => toggleAngle(angle),
              },
            };
          }
          return n;
        });

        if (!wasExpanded) {
          // Add idea nodes
          const ideas = ideasByAngle.current[angle] || [];
          const angleNode = filtered.find((n) => n.id === `angle-${angle}`);
          if (angleNode) {
            const parentX = angleNode.position.x;
            const parentY = angleNode.position.y;
            ideas.forEach((idea, idx) => {
              const pos = ideaPosition(parentX, parentY, idx);
              filtered.push({
                id: `idea-${idea.id}`,
                type: "idea",
                position: pos,
                data: {
                  ideaId: idea.id,
                  title: idea.title,
                  source: idea.source,
                  summary: idea.summary,
                  url: idea.url,
                  angle: idea.angle,
                  favorited: isFavorited(idea.id),
                  onSelect: () => setSelectedIdea(idea),
                  onToggleFavorite: () => handleToggleFavoriteOnNode(idea),
                },
              });
            });
          }
        }

        return filtered;
      });

      setEdges((currentEdges) => {
        // Remove idea edges for this angle
        let filtered = currentEdges.filter(
          (e) => !e.id.startsWith(`edge-${angle}-idea-`),
        );

        if (!wasExpanded) {
          const ideas = ideasByAngle.current[angle] || [];
          ideas.forEach((idea) => {
            filtered.push({
              id: `edge-${angle}-idea-${idea.id}`,
              source: `angle-${angle}`,
              target: `idea-${idea.id}`,
              type: "smoothstep",
              style: { stroke: "rgba(255,255,255,0.06)", strokeWidth: 1 },
            });
          });
        }

        return filtered;
      });
    },
    [isFavorited, setNodes, setEdges],
  );

  // -------------------------------------------------------------------------
  // Toggle favorite on node + persist
  // -------------------------------------------------------------------------

  const handleToggleFavoriteOnNode = useCallback(
    (idea: IdeaResult) => {
      toggleFavorite(idea);
      setNodes((currentNodes) =>
        currentNodes.map((n) => {
          if (n.id === `idea-${idea.id}`) {
            const current = (n.data as { favorited?: boolean }).favorited ?? false;
            return {
              ...n,
              data: { ...n.data, favorited: !current },
            };
          }
          return n;
        }),
      );
    },
    [toggleFavorite, setNodes],
  );

  // -------------------------------------------------------------------------
  // Submit handler
  // -------------------------------------------------------------------------

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (topicInput.trim()) handleExplore(topicInput.trim());
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="relative h-[calc(100vh-65px)] w-full bg-neutral-950">
      {/* Empty state — input overlay */}
      {!hasExplored && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <form
            onSubmit={handleSubmit}
            className="flex w-full max-w-lg flex-col items-center gap-5"
          >
            <div className="flex items-center gap-2 text-neutral-400">
              <Sparkles className="h-5 w-5 text-violet-400" />
              <span className="text-lg font-medium text-white">Ideas Canvas</span>
            </div>
            <p className="text-center text-sm text-neutral-500">
              Explore ideias progressivamente: tema &rarr; angulos &rarr; ideias &rarr; keywords &rarr; titulos
            </p>
            <div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-neutral-900/80 px-4 py-3 backdrop-blur">
              <Search className="h-4 w-4 text-neutral-500" />
              <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder="Qual tema quer explorar?"
                className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-neutral-600"
                autoFocus
              />
              <button
                type="submit"
                disabled={!topicInput.trim()}
                className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
              >
                Explorar
              </button>
            </div>
          </form>
        </div>
      )}

      {/* React Flow canvas */}
      {hasExplored && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(255,255,255,0.04)" />
          <Controls
            showInteractive={false}
            className="!rounded-xl !border-white/10 !bg-neutral-900/80 !shadow-xl"
          />
          <MiniMap
            className="!rounded-xl !border-white/10 !bg-neutral-900/60"
            maskColor="rgba(0,0,0,0.6)"
            nodeColor="rgba(139,92,246,0.4)"
          />
        </ReactFlow>
      )}

      {/* Detail panel */}
      {selectedIdea && (
        <IdeaDetailPanel
          idea={selectedIdea}
          favorited={isFavorited(selectedIdea.id)}
          onToggleFavorite={() => handleToggleFavoriteOnNode(selectedIdea)}
          onClose={() => setSelectedIdea(null)}
        />
      )}
    </div>
  );
}
