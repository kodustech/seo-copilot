import { NextResponse } from "next/server";

import {
  createWorkItemsBatch,
  listExistingSourceRefs,
  type CreateWorkItemInput,
} from "@/lib/kanban";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type FeedSource = "blog" | "changelog" | "all";

type FeedEntry = {
  id: string;
  title: string;
  link: string;
  excerpt?: string;
  content?: string;
  publishedAt?: string;
  source?: "blog" | "changelog";
};

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

async function safeReadJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function normalizeSource(value: unknown): FeedSource {
  if (value === "changelog") return "changelog";
  if (value === "all") return "all";
  return "blog";
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(30, Math.round(parsed)));
}

async function fetchFeedEntries(req: Request, source: FeedSource): Promise<FeedEntry[]> {
  const requestUrl = new URL(req.url);
  const endpoint = new URL("/api/feed", requestUrl.origin);
  endpoint.searchParams.set("source", source);

  const response = await fetch(endpoint.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      body && typeof body === "object" && typeof body.error === "string"
        ? body.error
        : `Error fetching feed (${response.status}).`;
    throw new Error(errorMessage);
  }

  const posts =
    body && typeof body === "object" && Array.isArray(body.posts)
      ? body.posts
      : [];

  return posts
    .map((entry: unknown): FeedEntry | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;

      const id =
        typeof record.id === "string" || typeof record.id === "number"
          ? String(record.id)
          : "";
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const link = typeof record.link === "string" ? record.link.trim() : "";

      if (!id || !title || !link) return null;

      const postSource =
        record.source === "changelog" ? "changelog" : "blog";

      return {
        id,
        title,
        link,
        excerpt: typeof record.excerpt === "string" ? record.excerpt : undefined,
        content: typeof record.content === "string" ? record.content : undefined,
        publishedAt:
          typeof record.publishedAt === "string" ? record.publishedAt : undefined,
        source: postSource,
      };
    })
    .filter((entry: FeedEntry | null): entry is FeedEntry => Boolean(entry));
}

export async function POST(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = await safeReadJson(req);

    const source = normalizeSource(body.source);
    const limit = normalizeLimit(body.limit);
    const feed = await fetchFeedEntries(req, source);
    const selected = feed.slice(0, limit);

    if (!selected.length) {
      return NextResponse.json({
        inserted: 0,
        skipped: 0,
        items: [],
        source,
      });
    }

    const refs = selected.map((entry) => `${entry.source ?? "blog"}:${entry.id}`);
    const existingRefs = await listExistingSourceRefs(client, userEmail, refs);

    const rows: CreateWorkItemInput[] = selected
      .filter((entry) => {
        const sourceRef = `${entry.source ?? "blog"}:${entry.id}`;
        return !existingRefs.has(sourceRef);
      })
      .map((entry) => {
        const sourceRef = `${entry.source ?? "blog"}:${entry.id}`;
        const content = entry.content?.trim() || entry.excerpt?.trim() || "";

        return {
          title: entry.title,
          description: content.slice(0, 280) || null,
          itemType: "idea",
          stage: "backlog",
          source: entry.source ?? "blog",
          sourceRef,
          priority: "medium",
          link: entry.link,
          payload: {
            externalId: entry.id,
            source: entry.source ?? "blog",
            excerpt: entry.excerpt ?? null,
            publishedAt: entry.publishedAt ?? null,
          },
        } satisfies CreateWorkItemInput;
      });

    const items = await createWorkItemsBatch(client, userEmail, rows);
    const skipped = selected.length - items.length;

    return NextResponse.json({
      inserted: items.length,
      skipped,
      items,
      source,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
