"use client";

import { useState } from "react";
import { Star, ExternalLink, Trash2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useFavorites, type FavoriteIdea } from "@/lib/use-favorites";
import type { IdeaAngle } from "@/lib/exa";

const ANGLE_BADGES: Record<IdeaAngle, { label: string; className: string }> = {
  pain_points: { label: "Dores", className: "bg-red-500/20 text-red-300 border-red-500/20" },
  questions: { label: "Perguntas", className: "bg-blue-500/20 text-blue-300 border-blue-500/20" },
  trends: { label: "Tendencias", className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/20" },
  comparisons: { label: "Comparacoes", className: "bg-amber-500/20 text-amber-300 border-amber-500/20" },
  best_practices: { label: "Boas Praticas", className: "bg-purple-500/20 text-purple-300 border-purple-500/20" },
};

const SOURCE_COLORS: Record<string, string> = {
  Reddit: "bg-orange-500/20 text-orange-300",
  "dev.to": "bg-emerald-500/20 text-emerald-300",
  HackerNews: "bg-amber-500/20 text-amber-300",
  StackOverflow: "bg-yellow-500/20 text-yellow-300",
  Twitter: "bg-sky-500/20 text-sky-300",
  Medium: "bg-neutral-500/20 text-neutral-300",
  Hashnode: "bg-blue-500/20 text-blue-300",
  LinkedIn: "bg-blue-600/20 text-blue-300",
};

type FilterAngle = IdeaAngle | "all";

export function FavoritesPage() {
  const { favorites, removeFavorite } = useFavorites();
  const [filter, setFilter] = useState<FilterAngle>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered =
    filter === "all"
      ? favorites
      : favorites.filter((f) => f.angle === filter);

  // Sort by most recently favorited
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.favoritedAt).getTime() - new Date(a.favoritedAt).getTime(),
  );

  const angleCounts = favorites.reduce(
    (acc, f) => {
      acc[f.angle] = (acc[f.angle] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Star className="h-6 w-6 fill-yellow-400 text-yellow-400" />
            Favoritos
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {favorites.length} {favorites.length === 1 ? "ideia salva" : "ideias salvas"}
          </p>
        </div>
        <Link
          href="/ideias"
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500"
        >
          <Sparkles className="h-4 w-4" />
          Explorar mais
        </Link>
      </div>

      {/* Filters */}
      {favorites.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            onClick={() => setFilter("all")}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              filter === "all"
                ? "bg-white/15 text-white"
                : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
            }`}
          >
            Todos ({favorites.length})
          </button>
          {(Object.keys(ANGLE_BADGES) as IdeaAngle[]).map((angle) => {
            const count = angleCounts[angle] || 0;
            if (count === 0) return null;
            const badge = ANGLE_BADGES[angle];
            return (
              <button
                key={angle}
                onClick={() => setFilter(filter === angle ? "all" : angle)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  filter === angle
                    ? badge.className
                    : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {badge.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {favorites.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <Star className="h-12 w-12 text-neutral-800" />
          <p className="text-neutral-500">Nenhuma ideia favoritada ainda.</p>
          <Link
            href="/ideias"
            className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-violet-500"
          >
            Ir para o Ideas Canvas
          </Link>
        </div>
      )}

      {/* Cards */}
      <div className="space-y-3">
        {sorted.map((idea) => (
          <FavoriteCard
            key={idea.id}
            idea={idea}
            expanded={expanded.has(idea.id)}
            onToggleExpand={() => toggleExpand(idea.id)}
            onRemove={() => removeFavorite(idea.id)}
          />
        ))}
      </div>
    </div>
  );
}

function FavoriteCard({
  idea,
  expanded,
  onToggleExpand,
  onRemove,
}: {
  idea: FavoriteIdea;
  expanded: boolean;
  onToggleExpand: () => void;
  onRemove: () => void;
}) {
  const angleBadge = ANGLE_BADGES[idea.angle];
  const sourceColor = SOURCE_COLORS[idea.source] ?? "bg-white/10 text-neutral-400";

  return (
    <div className="rounded-xl border border-white/[0.06] bg-neutral-900/60 transition hover:border-white/10">
      <div
        className="cursor-pointer px-5 py-4"
        onClick={onToggleExpand}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h3 className="text-sm font-semibold leading-snug text-white">
              {idea.title}
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${angleBadge.className}`}>
                {angleBadge.label}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sourceColor}`}>
                {idea.source}
              </span>
              <span className="text-[10px] text-neutral-600">
                {new Date(idea.favoritedAt).toLocaleDateString("pt-BR")}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <a
              href={idea.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="rounded-lg p-1.5 text-neutral-600 transition hover:bg-white/10 hover:text-white"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="rounded-lg p-1.5 text-neutral-600 transition hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/[0.04] px-5 py-4 space-y-3">
          {idea.summary && (
            <p className="text-sm leading-relaxed text-neutral-400">{idea.summary}</p>
          )}
          {idea.highlights.length > 0 && (
            <div className="space-y-2">
              {idea.highlights.map((h, i) => (
                <blockquote
                  key={i}
                  className="border-l-2 border-violet-500/30 pl-3 text-sm italic text-neutral-500"
                >
                  {h}
                </blockquote>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
