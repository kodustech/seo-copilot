"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Bug, Loader2, RefreshCw, Search, Sparkles } from "lucide-react";

import { CardNode, type CardNodeData } from "@/components/canvas/card-node";
import { LaneNode, type LaneNodeData } from "@/components/canvas/lane-node";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type {
  IdeaCard,
  IdeaLane,
  IdeaLaneKey,
  IdeaSession,
} from "@/lib/ideas";

type CardState = "idle" | "saved" | "dismissed" | "promoted";

const NODE_TYPES = {
  lane: LaneNode,
  card: CardNode,
} as const;

const LANE_ORDER: IdeaLaneKey[] = [
  "topic",
  "bubble",
  "my_data",
  "gap",
  "hot_takes",
];

const LANE_WIDTH = 260;
const LANE_SPACING = 80;
const LANE_Y = 180;
const CARD_START_Y = 340;
const CARD_SPACING_Y = 300;

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setToken(session?.access_token ?? null);
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  return { token, supabase };
}

type CardStateEntry = {
  card_key: string;
  state: CardState;
};

export function IdeasCanvas() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTopic = searchParams.get("topic") ?? "";

  const { token, supabase } = useAuthToken();

  const [session, setSession] = useState<IdeaSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topicInput, setTopicInput] = useState(initialTopic);
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});
  const [debugOutput, setDebugOutput] = useState<unknown>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const authHeaders = useCallback(() => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }, [token]);

  const getFreshToken = useCallback(async (): Promise<string | null> => {
    if (!supabase) return token;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? token;
  }, [supabase, token]);

  const loadCardStates = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/ideas/cards", { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<string, CardState> = {};
      for (const entry of (data.cards ?? []) as CardStateEntry[]) {
        map[entry.card_key] = entry.state;
      }
      setCardStates(map);
    } catch {
      // Non-fatal: cards render as idle
    }
  }, [token, authHeaders]);

  const loadSession = useCallback(
    async (options: { topic?: string | null; force?: boolean } = {}) => {
      if (!token) return;
      setError(null);
      if (options.force) setRefreshing(true);
      else setLoading(true);

      try {
        const method = options.force ? "POST" : "GET";
        const url =
          options.topic && !options.force
            ? `/api/ideas?topic=${encodeURIComponent(options.topic)}`
            : "/api/ideas";

        const init: RequestInit = {
          method,
          headers: authHeaders(),
        };
        if (options.force) {
          init.body = JSON.stringify(
            options.topic ? { topic: options.topic } : {},
          );
        }

        const res = await fetch(url, init);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load ideas.");
        setSession(data.session as IdeaSession);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token, authHeaders],
  );

  useEffect(() => {
    if (token) {
      void loadSession({ topic: initialTopic || null });
      void loadCardStates();
    }
    // We only want this to run on token change / first topic hydration, not
    // every time initialTopic updates mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const updateCardState = useCallback(
    async (cardKey: string, state: CardState, payload: IdeaCard) => {
      const freshToken = await getFreshToken();
      if (!freshToken) return;

      setCardStates((prev) => ({ ...prev, [cardKey]: state }));

      try {
        await fetch("/api/ideas/cards", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshToken}`,
          },
          body: JSON.stringify({ cardKey, state, payload }),
        });
      } catch {
        // Best-effort — local state already reflects the choice.
      }
    },
    [getFreshToken],
  );

  const handleDismiss = useCallback(
    (card: IdeaCard) => {
      void updateCardState(card.id, "dismissed", card);
    },
    [updateCardState],
  );

  const [kanbanBusy, setKanbanBusy] = useState<Record<string, boolean>>({});

  const handleSendToKanban = useCallback(
    async (card: IdeaCard) => {
      const freshToken = await getFreshToken();
      if (!freshToken) return;
      setKanbanBusy((prev) => ({ ...prev, [card.id]: true }));
      try {
        const itemType =
          card.suggestedFormat === "linkedin" ||
          card.suggestedFormat === "twitter"
            ? "social"
            : "idea";
        const description = [
          card.angle,
          `Why it might work: ${card.whyItWorks}`,
        ]
          .filter(Boolean)
          .join("\n\n");

        const res = await fetch("/api/kanban/items", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshToken}`,
          },
          body: JSON.stringify({
            title: card.workingTitle,
            description,
            itemType,
            stage: "backlog",
            source: "agent",
            sourceRef: card.id,
            priority: "medium",
            payload: {
              lane: card.lane,
              source: card.source,
              suggestedFormat: card.suggestedFormat,
            },
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Failed to add to Kanban.");
        }

        void updateCardState(card.id, "saved", card);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setKanbanBusy((prev) => {
          const next = { ...prev };
          delete next[card.id];
          return next;
        });
      }
    },
    [getFreshToken, updateCardState],
  );

  const runDebug = useCallback(async () => {
    if (!token) return;
    setDebugLoading(true);
    setDebugOpen(true);
    setDebugOutput(null);
    try {
      const res = await fetch("/api/ideas/debug", { headers: authHeaders() });
      const data = await res.json();
      setDebugOutput(data);
    } catch (err) {
      setDebugOutput({
        error: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setDebugLoading(false);
    }
  }, [token, authHeaders]);

  const goToContentCanvas = useCallback(
    (card: IdeaCard, mode: "blog" | "social") => {
      void updateCardState(card.id, "promoted", card);
      const params = new URLSearchParams({
        topic: card.workingTitle,
        mode,
        angle: card.angle,
      });
      router.push(`/?${params.toString()}`);
    },
    [router, updateCardState],
  );

  const handleDraftBlog = useCallback(
    (card: IdeaCard) => goToContentCanvas(card, "blog"),
    [goToContentCanvas],
  );

  const handleDraftSocial = useCallback(
    (card: IdeaCard) => goToContentCanvas(card, "social"),
    [goToContentCanvas],
  );

  // Rebuild the full graph only when the session changes. Card drag positions
  // are preserved because cardStates/handler changes don't retrigger a rebuild.
  useEffect(() => {
    if (!session) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const visibleLanes = session.lanes.filter((lane) => {
      if (lane.key === "topic" && !session.topic) return false;
      return true;
    });
    visibleLanes.sort(
      (a, b) => LANE_ORDER.indexOf(a.key) - LANE_ORDER.indexOf(b.key),
    );

    const laneCount = visibleLanes.length;
    const totalWidth =
      laneCount * LANE_WIDTH + Math.max(0, laneCount - 1) * LANE_SPACING;
    const startX = -totalWidth / 2;

    const nextNodes: Node[] = [];
    const nextEdges: Edge[] = [];

    visibleLanes.forEach((lane: IdeaLane, laneIndex) => {
      const laneX = startX + laneIndex * (LANE_WIDTH + LANE_SPACING);

      nextNodes.push({
        id: `lane-${lane.key}`,
        type: "lane",
        position: { x: laneX, y: LANE_Y },
        data: {
          lane: lane.key,
          label: lane.label,
          description: lane.description,
          count: lane.cards.length,
          error: lane.error,
        } satisfies LaneNodeData,
        draggable: true,
        selectable: false,
      });

      lane.cards.forEach((card, cardIndex) => {
        const cardId = `card-${card.id}`;
        nextNodes.push({
          id: cardId,
          type: "card",
          position: {
            x: laneX + (LANE_WIDTH - 300) / 2,
            y: CARD_START_Y + cardIndex * CARD_SPACING_Y,
          },
          data: {
            card,
            state: "idle",
          } satisfies CardNodeData,
          draggable: true,
          selectable: true,
        });

        nextEdges.push({
          id: `edge-${lane.key}-${card.id}`,
          source: `lane-${lane.key}`,
          target: cardId,
          animated: false,
          style: { stroke: "rgba(255,255,255,0.1)" },
        });
      });
    });

    setNodes(nextNodes);
    setEdges(nextEdges);
  }, [session, setEdges, setNodes]);

  // Patch card nodes when states or handlers change, without resetting the
  // positions the user might have dragged.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.type !== "card") return node;
        const data = node.data as unknown as CardNodeData;
        const card = data.card;
        return {
          ...node,
          data: {
            card,
            state: cardStates[card.id] ?? "idle",
            kanbanBusy: Boolean(kanbanBusy[card.id]),
            onDraftBlog: () => handleDraftBlog(card),
            onDraftSocial: () => handleDraftSocial(card),
            onSendToKanban: () => handleSendToKanban(card),
            onDismiss: () => handleDismiss(card),
          } satisfies CardNodeData,
        };
      }),
    );
  }, [
    cardStates,
    kanbanBusy,
    handleDraftBlog,
    handleDraftSocial,
    handleSendToKanban,
    handleDismiss,
    setNodes,
  ]);

  const totalIdeas = session?.cards.length ?? 0;
  const hasSession = Boolean(session);
  const isLoading = loading && !hasSession;

  return (
    <div className="relative flex h-full w-full flex-col bg-neutral-950 text-neutral-100">
      <div className="absolute left-1/2 top-6 z-10 w-full max-w-2xl -translate-x-1/2 px-4">
        <div className="rounded-2xl border border-white/10 bg-neutral-900/90 p-4 shadow-xl backdrop-blur">
          <div className="flex items-center gap-2 text-white">
            <Sparkles className="h-5 w-5 text-violet-300" />
            <span className="text-sm font-semibold">Ideas canvas</span>
            {session?.generatedAt ? (
              <span className="ml-auto text-[11px] text-neutral-500">
                generated{" "}
                {new Date(session.generatedAt).toLocaleString("en-US", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            ) : null}
          </div>
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const topic = topicInput.trim() || null;
              // Sync the URL so refresh/share/back preserves the topic.
              router.replace(
                topic ? `/ideas?topic=${encodeURIComponent(topic)}` : "/ideas",
                { scroll: false },
              );
              void loadSession({ topic, force: true });
            }}
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <input
                type="text"
                value={topicInput}
                onChange={(event) => setTopicInput(event.target.value)}
                placeholder="Optional: narrow all lanes around a topic..."
                className="w-full rounded-lg border border-white/10 bg-neutral-950 py-2 pl-10 pr-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
              />
            </div>
            <button
              type="submit"
              disabled={refreshing}
              className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {topicInput.trim() ? "Generate" : "Refresh"}
            </button>
          </form>
          {session?.topic ? (
            <p className="mt-2 text-[11px] text-neutral-500">
              Current topic:{" "}
              <span className="text-neutral-300">{session.topic}</span>
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-300">
              {error}
            </p>
          ) : null}
          {totalIdeas > 0 ? (
            <p className="mt-1 text-[11px] text-neutral-500">
              {totalIdeas} ideas across {session?.lanes.length ?? 0} lanes
            </p>
          ) : null}
          <button
            type="button"
            onClick={runDebug}
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-neutral-500 transition hover:text-neutral-300"
          >
            <Bug className="h-3 w-3" />
            Diagnose lanes
          </button>
        </div>
      </div>

      {debugOpen ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setDebugOpen(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-white/10 bg-neutral-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Bug className="h-4 w-4 text-amber-400" />
                Ideas diagnostic
              </div>
              <button
                type="button"
                onClick={() => setDebugOpen(false)}
                className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-white/5 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="max-h-[70vh] overflow-auto p-4 text-xs">
              {debugLoading ? (
                <div className="flex items-center gap-2 text-neutral-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Running probes...
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-neutral-200">
                  {JSON.stringify(debugOutput, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-neutral-400">
            <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
            <p className="text-sm">Generating ideas from your 5 lanes...</p>
            <p className="text-xs text-neutral-500">
              First load: ~15–25s. Next time this will be instant (cached 6h).
            </p>
          </div>
        </div>
      ) : (
        <div className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.3}
            maxZoom={1.4}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
            <Controls
              className="!bg-neutral-900 !border-white/10"
              showInteractive={false}
            />
            <MiniMap
              pannable
              className="!bg-neutral-900 !border-white/10"
              nodeColor={() => "#1e293b"}
              maskColor="rgba(0,0,0,0.6)"
            />
          </ReactFlow>

          {refreshing ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/70 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-violet-400/30 bg-neutral-900/90 px-8 py-6 text-neutral-200 shadow-xl">
                <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
                <p className="text-sm font-medium">
                  Regenerating ideas from all lanes...
                </p>
                <p className="text-[11px] text-neutral-500">
                  ~15–25s. Previous cards stay visible behind.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
