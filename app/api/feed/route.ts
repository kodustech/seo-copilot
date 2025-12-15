import { NextResponse } from "next/server";

const WORDPRESS_API_BASE =
  process.env.WORDPRESS_API_BASE?.replace(/\/$/, "") ||
  "https://kodus.io/wp-json/wp/v2";

type FeedItem = {
  id: string;
  title: string;
  link: string;
  excerpt: string;
  content: string;
  publishedAt?: string;
};

export async function GET() {
  try {
    const posts = await fetchWordPressPosts();
    return NextResponse.json({ posts });
  } catch (error) {
    console.error("Erro ao carregar posts do WordPress", error);
    return NextResponse.json(
      { error: "Não foi possível carregar os posts agora." },
      { status: 500 },
    );
  }
}

async function fetchWordPressPosts(): Promise<FeedItem[]> {
  const endpoint = new URL(`${WORDPRESS_API_BASE}/posts`);
  endpoint.searchParams.set("per_page", "20");
  endpoint.searchParams.set("orderby", "date");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set(
    "_fields",
    "id,title.rendered,link,date,content.rendered,excerpt.rendered",
  );

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    const body = await safeReadJson(response);
    throw new Error(
      `Falha ao buscar posts (${response.status}). ${
        body?.message || "Tente novamente."
      }`,
    );
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((item) => normalizeWordPressItem(item))
    .filter((item): item is FeedItem => Boolean(item));
}

function normalizeWordPressItem(item: unknown): FeedItem | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const idValue = record.id;
  const id =
    typeof idValue === "number"
      ? String(idValue)
      : typeof idValue === "string"
        ? idValue
        : null;

  const title = stripHtml(getRendered(record.title)) || "";
  const link =
    typeof record.link === "string" && record.link.trim().length > 0
      ? record.link.trim()
      : "";

  if (!id || !title || !link) {
    return null;
  }

  const contentHtml = getRendered(record.content);
  const excerptHtml = getRendered(record.excerpt);
  const content = stripHtml(contentHtml) || stripHtml(excerptHtml);
  const excerpt =
    stripHtml(excerptHtml) || (content ? buildExcerpt(content) : "");

  return {
    id,
    title,
    link,
    content,
    excerpt,
    publishedAt:
      typeof record.date === "string"
        ? new Date(record.date).toISOString()
        : undefined,
  };
}

function getRendered(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.rendered === "string") {
      return record.rendered;
    }
  }
  return "";
}

function stripHtml(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const withBreaks = value
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return withBreaks
    .replace(/<[^>]*>/g, " ")
    .replace(/\r?\n\s*/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function buildExcerpt(value: string, maxLength = 260): string {
  if (!value) return "";
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trim()}...`;
}

async function safeReadJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
