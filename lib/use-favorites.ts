"use client";

import { useCallback, useEffect, useState } from "react";
import type { IdeaResult } from "@/lib/exa";

const STORAGE_KEY = "seo-copilot:favorites";

export type FavoriteIdea = IdeaResult & { favoritedAt: string };

function readFromStorage(): FavoriteIdea[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as FavoriteIdea[]) : [];
  } catch {
    return [];
  }
}

function writeToStorage(items: FavoriteIdea[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // storage full — silently ignore
  }
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteIdea[]>([]);

  // Hydrate from localStorage after mount
  useEffect(() => {
    setFavorites(readFromStorage());
  }, []);

  const isFavorited = useCallback(
    (ideaId: string) => favorites.some((f) => f.id === ideaId),
    [favorites],
  );

  const toggleFavorite = useCallback(
    (idea: IdeaResult) => {
      setFavorites((prev) => {
        const exists = prev.some((f) => f.id === idea.id);
        const next = exists
          ? prev.filter((f) => f.id !== idea.id)
          : [...prev, { ...idea, favoritedAt: new Date().toISOString() }];
        writeToStorage(next);
        return next;
      });
    },
    [],
  );

  const removeFavorite = useCallback((ideaId: string) => {
    setFavorites((prev) => {
      const next = prev.filter((f) => f.id !== ideaId);
      writeToStorage(next);
      return next;
    });
  }, []);

  return { favorites, isFavorited, toggleFavorite, removeFavorite };
}
