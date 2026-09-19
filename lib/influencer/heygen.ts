/**
 * HeyGen API: the fleet's avatar renderer. Thin fetch wrappers — the publisher
 * calls these, tests cover the request builders, and no key ever leaves the
 * server (it arrives decrypted from the vault per call).
 */
import { decryptPersonaKey } from "@/lib/crypto/persona-secrets";
import { getChannelCredentialCipher } from "@/lib/influencer/credentials";
import type { SupabaseClient } from "@supabase/supabase-js";

export const HEYGEN_API_BASE = "https://api.heygen.com";

export type HeyGenVideoRequest = {
  avatarId: string;
  /** Spoken script. Mutually exclusive with audioAssetId. */
  script?: string;
  voiceId?: string;
  /** Pre-rendered narration (e.g. ElevenLabs) to lip-sync instead of TTS. */
  audioAssetId?: string;
  /** White matte: the compositor keying it out must stay in sync with this. */
  removeBackground?: boolean;
  title?: string;
  resolution?: "720p" | "1080p";
};

export function buildHeyGenVideoBody(req: HeyGenVideoRequest): Record<string, unknown> {
  if (!req.avatarId.trim()) throw new Error("avatar_id is required.");
  const hasScript = !!req.script?.trim();
  const hasAudio = !!req.audioAssetId?.trim();
  if (hasScript === hasAudio) {
    throw new Error("Pass exactly one audio source: script (+ voice_id) or audio_asset_id.");
  }
  const body: Record<string, unknown> = {
    type: "avatar",
    avatar_id: req.avatarId.trim(),
    title: req.title?.trim() || "persona video",
    resolution: req.resolution ?? "720p",
    aspect_ratio: "16:9",
  };
  if (hasScript) {
    body.script = req.script!.trim();
    if (req.voiceId?.trim()) body.voice_id = req.voiceId.trim();
  } else {
    body.audio_asset_id = req.audioAssetId!.trim();
  }
  if (req.removeBackground) body.remove_background = true;
  return body;
}

export type HeyGenVideoStatus = {
  videoId: string;
  status: "waiting" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  durationSeconds: number | null;
  failureMessage: string | null;
};

function parseHeyGenStatus(videoId: string, body: unknown): HeyGenVideoStatus {
  const data = (body as { data?: Record<string, unknown> })?.data ?? {};
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const status = text(data.status);
  return {
    videoId,
    status: status === "completed" || status === "failed" || status === "processing" ? status : "waiting",
    videoUrl: text(data.video_url),
    durationSeconds: num(data.duration),
    failureMessage: text(data.failure_message),
  };
}

async function heygenFetch(
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${HEYGEN_API_BASE}${path}`, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HeyGen ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<unknown>;
}

export async function createHeyGenVideo(apiKey: string, req: HeyGenVideoRequest): Promise<string> {
  const body = await heygenFetch(apiKey, "/v3/videos", {
    method: "POST",
    body: JSON.stringify(buildHeyGenVideoBody(req)),
  });
  const data = (body as { data?: Record<string, unknown> })?.data ?? {};
  const videoId = typeof data.video_id === "string" ? data.video_id : "";
  if (!videoId) throw new Error("HeyGen accepted the render but returned no video_id.");
  return videoId;
}

export async function getHeyGenVideo(apiKey: string, videoId: string): Promise<HeyGenVideoStatus> {
  const body = await heygenFetch(apiKey, `/v3/videos/${videoId}`);
  return parseHeyGenStatus(videoId, body);
}

/** Upload narration audio once, lip-sync many clips against it. MP3/WAV ≤32MB. */
export async function uploadHeyGenAudioAsset(
  apiKey: string,
  bytes: Uint8Array | Buffer,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes as unknown as BlobPart]), filename);
  const res = await fetch(`${HEYGEN_API_BASE}/v3/assets`, {
    method: "POST",
    headers: { "X-Api-Key": apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HeyGen /v3/assets HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = ((await res.json()) as { data?: Record<string, unknown> })?.data ?? {};
  const id = typeof data.id === "string" ? data.id : "";
  if (!id) throw new Error("HeyGen asset upload returned no id.");
  return id;
}

/**
 * Resolve the HeyGen key for a persona. Channel-scoped ("heygen" provider on
 * the vault row) so two personas never share one wallet.
 */
export async function resolveHeyGenKey(
  client: SupabaseClient,
  personaId: string,
): Promise<string> {
  const cipher = await getChannelCredentialCipher(client, personaId, "heygen");
  if (!cipher) {
    throw new Error("No HeyGen key for this persona. Connect one (channel credentials, provider 'heygen').");
  }
  const key = decryptPersonaKey(cipher).trim();
  if (!key) throw new Error("Stored HeyGen key is empty. Reconnect it.");
  return key;
}
