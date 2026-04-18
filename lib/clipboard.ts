// Robust clipboard copy that works across browsers/contexts.
// Falls back to a hidden textarea + execCommand when the async Clipboard
// API is unavailable, blocked, or rejected (common on unfocused windows,
// Safari private mode, or http:// origins).
export async function copyToClipboard(text: string): Promise<void> {
  if (!text) {
    throw new Error("Nothing to copy.");
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to legacy
    }
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard not available in this environment.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    if (!ok) {
      throw new Error("Clipboard write rejected by browser.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
