/**
 * Resolve a draft's image intent into Post-Bridge media at publish time. The
 * persona declares WHAT image it wants in queue_draft (stored on the activity);
 * the publish step turns that into real media here — keeping the brain/body
 * split (the agent never touches the wire).
 *
 * Everything resolves to UPLOADED bytes (Post-Bridge `media` ids) — no image-gen
 * API needed (the Gemini path is billing-blocked; CSE/Imgflip aren't configured):
 *  - "screenshot": capture the real page with the browser (a benchmark chart, a
 *    tool's UI, a tweet, a GitHub diff) — real evidence.
 *  - "image_url": download a public image (e.g. an article's own figure) and
 *    upload its bytes.
 */
import { screenshotPage } from "@/lib/influencer/browser";
import { assertPublicUrl } from "@/lib/influencer/url-guard";
import { uploadImageBytesToPostBridge } from "@/lib/copilot";

export type ImageIntent =
  | { kind: "screenshot"; url: string }
  | { kind: "image_url"; url: string };

export type PostMedia = { mediaIds: string[] };

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Pull a valid image intent out of an activity's content_meta, or null. */
export function parseImageIntent(raw: unknown): ImageIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const image = (raw as Record<string, unknown>).image;
  if (!image || typeof image !== "object") return null;
  const o = image as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!url) return null;
  if (o.kind === "screenshot") return { kind: "screenshot", url };
  if (o.kind === "image_url") return { kind: "image_url", url };
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\./, "");
  } catch {
    return null;
  }
}

function isXHost(host: string | null): boolean {
  return host === "x.com" || host === "www.x.com" || (host?.endsWith(".x.com") ?? false);
}

/** Download a public image URL as bytes (SSRF-guarded, size- and type-checked). */
async function fetchImageBytes(url: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const parsed = await assertPublicUrl(url);
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(15_000),
    redirect: "error", // don't let a redirect bounce past the SSRF guard
  });
  if (!res.ok) return null;
  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  return { bytes, mimeType };
}

/**
 * Turn an intent into media. Never throws — an image is a nice-to-have, so a
 * failure returns null and the post still goes out as text.
 */
export async function resolvePostImage(intent: ImageIntent): Promise<PostMedia | null> {
  try {
    let img: { bytes: Buffer; mimeType: string } | null;
    if (intent.kind === "image_url") {
      img = await fetchImageBytes(intent.url);
    } else {
      // Screenshotting X needs the logged-in context + residential proxy, or the
      // capture is the logged-out / blocked view. Other hosts screenshot plainly.
      const onX = isXHost(hostOf(intent.url));
      const contextId = onX ? process.env.BROWSERBASE_X_CONTEXT_ID?.trim() || undefined : undefined;
      const shot = await screenshotPage(intent.url, {
        timeoutMs: 30_000,
        contextId,
        proxies: onX,
      });
      img = { bytes: shot.bytes, mimeType: shot.mimeType };
    }
    if (!img) return null;
    const mediaId = await uploadImageBytesToPostBridge(img);
    return { mediaIds: [mediaId] };
  } catch {
    return null;
  }
}
