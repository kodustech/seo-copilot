/**
 * Resolve a draft's image intent into Post-Bridge media at publish time. The
 * persona declares WHAT image it wants in queue_draft (stored on the activity);
 * the publish step turns that into real media here — keeping the brain/body
 * split (the agent never touches the wire).
 *
 * Two billing-free sources (no image-gen API needed):
 *  - "screenshot": capture the real page with the browser — a benchmark chart,
 *    a tool's UI, a tweet, a GitHub diff — and upload the PNG. Real evidence.
 *  - "image_url": a public image URL (e.g. an article's own og:image), attached
 *    directly.
 */
import { screenshotPage } from "@/lib/influencer/browser";
import { assertPublicUrl } from "@/lib/influencer/url-guard";
import { uploadImageBytesToPostBridge } from "@/lib/copilot";

export type ImageIntent =
  | { kind: "screenshot"; url: string }
  | { kind: "image_url"; url: string };

export type PostMedia = { mediaIds?: string[]; mediaUrls?: string[] };

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

/**
 * Turn an intent into media. Never throws — an image is a nice-to-have, so a
 * failure returns null and the post still goes out as text.
 */
export async function resolvePostImage(intent: ImageIntent): Promise<PostMedia | null> {
  try {
    if (intent.kind === "image_url") {
      await assertPublicUrl(intent.url); // block private/reserved hosts
      return { mediaUrls: [intent.url] };
    }
    const shot = await screenshotPage(intent.url, { timeoutMs: 30_000 });
    const mediaId = await uploadImageBytesToPostBridge({
      bytes: shot.bytes,
      mimeType: shot.mimeType,
    });
    return { mediaIds: [mediaId] };
  } catch {
    return null;
  }
}
