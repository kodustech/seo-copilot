/**
 * YouTube Data API: resumable upload + the honesty boundary.
 *
 * The API uploads bytes; it does NOT expose the "altered content" AI
 * checkbox — that lives in YouTube Studio only. So every upload lands
 * `unlisted` with the AI note in the description, and a person flips the
 * checkbox + publishes. An "auto" youtube channel is refused: there is no
 * publish path here that skips the human, by construction.
 */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export type YoutubeUploadInput = {  accessToken: string;
  title: string;
  description: string;
  /** File bytes of the finished mp4. */
  videoBytes: Uint8Array | Buffer;
  mimeType?: string;
  /** Always unlisted — see module doc. Never accept anything else. */
  privacyStatus?: "unlisted";
  categoryId?: string;
};

export function buildYoutubeVideoMetadata(input: {
  title: string;
  description: string;
  categoryId?: string;
}): Record<string, unknown> {
  const title = input.title.trim().slice(0, 100);
  if (!title) throw new Error("YouTube title is required (≤100 chars).");
  return {
    snippet: {
      title,
      description: input.description,
      categoryId: input.categoryId ?? "28",
    },
    status: {
      // Unlisted, always. The person who confirms the AI-content checkbox
      // publishes from Studio. Anything else here would bypass disclosure.
      privacyStatus: "unlisted",
      selfDeclaredMadeForKids: false,
    },
  };
}

export type YoutubeUploadResult = { videoId: string; watchUrl: string };

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

/** Step 2: PUT the bytes; resolves to the video id once processing starts. */
export async function uploadYoutubeBytes(
  sessionUrl: string,
  accessToken: string,
  videoBytes: Uint8Array | Buffer,
  mimeType = "video/mp4",
): Promise<string> {
  const res = await fetch(sessionUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": mimeType },
    body: videoBytes as unknown as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube upload HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("YouTube upload finished without a video id.");
  return body.id;
}

export async function uploadYoutubeVideo(input: YoutubeUploadInput): Promise<YoutubeUploadResult> {
  if (input.privacyStatus && input.privacyStatus !== "unlisted") {
    throw new Error('YouTube uploads are always unlisted — a person publishes from Studio after the AI-content checkbox.');
  }
  const metadata = buildYoutubeVideoMetadata({
    title: input.title,
    description: input.description,
    categoryId: input.categoryId,
  });
  const bytes = input.videoBytes;
  const sessionUrl = await startYoutubeUploadSession(
    input.accessToken,
    metadata,
    bytes.byteLength,
    input.mimeType ?? "video/mp4",
  );
  const videoId = await uploadYoutubeBytes(sessionUrl, input.accessToken, bytes, input.mimeType ?? "video/mp4");
  return { videoId, watchUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

/**
 * Exchange the stored refresh token (vault, provider "youtube") for a live
 * access token. Client id/secret live in env — never in a row anyone can edit.
 */
export async function getYoutubeAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_YOUTUBE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_YOUTUBE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("YouTube OAuth is not configured (GOOGLE_YOUTUBE_CLIENT_ID/SECRET).");
  }
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
