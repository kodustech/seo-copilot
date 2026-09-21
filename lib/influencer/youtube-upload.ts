/**
 * YouTube Data API: resumable upload.
 *
 * Every upload sets status.containsSyntheticMedia, the API side of Studio's
 * "altered or synthetic content" label, so disclosure never waits on a
 * person. Visibility comes from the channel. YouTube itself holds uploads from
 * an API project that has not passed its audit at private, whatever we ask
 * for, so the upload reports back the visibility YouTube actually applied.
 */
import { youtubeOAuthClient } from "@/lib/influencer/youtube-oauth";
import type { YoutubePrivacy } from "@/lib/influencer/youtube";

export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export type YoutubeUploadInput = {
  accessToken: string;
  title: string;
  description: string;
  /** File bytes of the finished mp4. */
  videoBytes: Uint8Array | Buffer;
  mimeType?: string;
  privacyStatus: YoutubePrivacy;
  tags?: string[];
  categoryId?: string;
};

export function buildYoutubeVideoMetadata(input: {
  title: string;
  description: string;
  privacyStatus: YoutubePrivacy;
  tags?: string[];
  categoryId?: string;
}): Record<string, unknown> {
  const title = input.title.trim().slice(0, 100);
  if (!title) throw new Error("YouTube title is required (≤100 chars).");
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 15);
  return {
    snippet: {
      title,
      description: input.description,
      categoryId: input.categoryId ?? "28",
      ...(tags.length ? { tags } : {}),
    },
    status: {
      privacyStatus: input.privacyStatus,
      // The presenter is an AI avatar with a synthetic voice: always disclosed.
      containsSyntheticMedia: true,
      selfDeclaredMadeForKids: false,
    },
  };
}

export type YoutubeUploadResult = {
  videoId: string;
  watchUrl: string;
  /** What YouTube applied, which can be stricter than what was asked. */
  privacyStatus: string | null;
};

/** Step 1 of resumable upload: session URL for the byte transfer. */
export async function startYoutubeUploadSession(
  accessToken: string,
  metadata: Record<string, unknown>,
  contentLength: number,
  mimeType = "video/mp4",
): Promise<string> {
  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(contentLength),
        "X-Upload-Content-Type": mimeType,
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube session HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const sessionUrl = res.headers.get("location");
  if (!sessionUrl) throw new Error("YouTube did not return an upload session URL.");
  return sessionUrl;
}

/** Step 2: PUT the bytes; resolves to the video resource once processing starts. */
export async function uploadYoutubeBytes(
  sessionUrl: string,
  accessToken: string,
  videoBytes: Uint8Array | Buffer,
  mimeType = "video/mp4",
): Promise<{ id: string; privacyStatus: string | null }> {
  const res = await fetch(sessionUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": mimeType },
    body: videoBytes as unknown as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube upload HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { id?: string; status?: { privacyStatus?: string } };
  if (!body.id) throw new Error("YouTube upload finished without a video id.");
  return { id: body.id, privacyStatus: body.status?.privacyStatus ?? null };
}

export async function uploadYoutubeVideo(input: YoutubeUploadInput): Promise<YoutubeUploadResult> {
  const metadata = buildYoutubeVideoMetadata({
    title: input.title,
    description: input.description,
    privacyStatus: input.privacyStatus,
    tags: input.tags,
    categoryId: input.categoryId,
  });
  const bytes = input.videoBytes;
  const sessionUrl = await startYoutubeUploadSession(
    input.accessToken,
    metadata,
    bytes.byteLength,
    input.mimeType ?? "video/mp4",
  );
  const uploaded = await uploadYoutubeBytes(sessionUrl, input.accessToken, bytes, input.mimeType ?? "video/mp4");
  return {
    videoId: uploaded.id,
    watchUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
    privacyStatus: uploaded.privacyStatus,
  };
}

/**
 * Exchange the stored refresh token (vault, provider "youtube") for a live
 * access token. Client id/secret live in env, never in a row anyone can edit.
 */
export async function getYoutubeAccessToken(refreshToken: string): Promise<string> {
  // Same client that issued the token: a refresh token only works with it.
  const { clientId, clientSecret } = youtubeOAuthClient();
  if (!refreshToken.trim()) throw new Error("YouTube channel is not connected (no refresh token).");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken.trim(),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube token refresh HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("YouTube token refresh returned no access token.");
  return body.access_token;
}
