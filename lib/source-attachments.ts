export type SourceAttachmentPayload = {
  id?: string;
  name: string;
  mimeType: string;
  size?: number;
  summary?: string;
  extractedText: string;
};

export const SOURCE_ATTACHMENT_MAX_FILES = 6;
export const SOURCE_ATTACHMENT_MAX_TEXT_CHARS = 14_000;

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function sanitizeSourceText(
  value: string,
  maxChars = SOURCE_ATTACHMENT_MAX_TEXT_CHARS,
): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trim()}\n\n[truncated]`;
}

export function normalizeSourceAttachments(
  raw: unknown,
  maxFiles = SOURCE_ATTACHMENT_MAX_FILES,
): SourceAttachmentPayload[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const attachments: SourceAttachmentPayload[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const name = readString(record, "name");
    const extractedText = sanitizeSourceText(readString(record, "extractedText"));

    if (!name || !extractedText) {
      continue;
    }

    attachments.push({
      id: readString(record, "id") || `source-${attachments.length + 1}`,
      name,
      mimeType: readString(record, "mimeType") || "application/octet-stream",
      size: readNumber(record, "size"),
      summary: sanitizeSourceText(readString(record, "summary"), 1_200) || undefined,
      extractedText,
    });

    if (attachments.length >= maxFiles) {
      break;
    }
  }

  return attachments;
}

export function formatSourceAttachmentsForPrompt(
  attachments: SourceAttachmentPayload[] | undefined,
  options?: { heading?: string },
): string | undefined {
  const normalized = normalizeSourceAttachments(attachments);

  if (!normalized.length) {
    return undefined;
  }

  const renderedSources = normalized
    .map((attachment, index) => {
      const label = `Source ${index + 1}: ${attachment.name}`;
      const summary = attachment.summary
        ? `\nSummary:\n${attachment.summary}`
        : "";

      return `[${label} | ${attachment.mimeType}]${summary}\nExtracted content:\n${attachment.extractedText}`;
    })
    .join("\n\n");

  return `${options?.heading ?? "Attached sources for this request"}:
These sources are scoped to this generation only. Use them as source material for this specific output, not as global memory.
Do not blend them with unrelated previous submissions. Do not claim an attached external source as the author's personal experience unless the user explicitly asked for that.
Every factual claim that depends on an attachment must be supported by the extracted content below.

${renderedSources}`;
}
