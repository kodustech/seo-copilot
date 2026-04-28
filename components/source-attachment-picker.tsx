"use client";

import { type ChangeEvent, useRef, useState } from "react";
import {
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  sanitizeSourceText,
  SOURCE_ATTACHMENT_MAX_FILE_BYTES,
  SOURCE_ATTACHMENT_MAX_FILE_LABEL,
  SOURCE_ATTACHMENT_MAX_FILES,
  SOURCE_ATTACHMENT_MAX_TEXT_CHARS,
  type SourceAttachmentPayload,
} from "@/lib/source-attachments";

const ACCEPTED_SOURCE_TYPES =
  ".pdf,image/*,.txt,.md,.markdown,.csv,.json,.log,text/plain,text/markdown,text/csv,application/json";

type SourceAttachmentPickerProps = {
  value: SourceAttachmentPayload[];
  onChange: (next: SourceAttachmentPayload[]) => void;
  token?: string | null;
  label?: string;
  helper?: string;
  disabled?: boolean;
  maxFiles?: number;
  instructionPlaceholder?: string;
};

export function SourceAttachmentPicker({
  value,
  onChange,
  token,
  label = "Source files",
  helper = "Attach sources for this generation only. PDF and images are extracted by the model.",
  disabled = false,
  maxFiles = SOURCE_ATTACHMENT_MAX_FILES,
  instructionPlaceholder = "Optional: tell the generator how to use this context.",
}: SourceAttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canAddFiles = !disabled && !extracting && value.length < maxFiles;

  async function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (!files.length) {
      return;
    }

    setError(null);
    setExtracting(true);

    try {
      let next = [...value];
      const availableSlots = Math.max(0, maxFiles - next.length);

      for (const file of files.slice(0, availableSlots)) {
        setCurrentFile(file.name);
        const attachment = await buildAttachment(file, token);
        next = [...next, attachment];
        onChange(next);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "We could not read that source.",
      );
    } finally {
      setCurrentFile(null);
      setExtracting(false);
    }
  }

  function handleRemove(id: string | undefined, index: number) {
    onChange(
      value.filter((attachment, attachmentIndex) => {
        if (id) {
          return attachment.id !== id;
        }
        return attachmentIndex !== index;
      }),
    );
  }

  function handleUsageInstructionsChange(index: number, instructions: string) {
    onChange(
      value.map((attachment, attachmentIndex) =>
        attachmentIndex === index
          ? {
              ...attachment,
              usageInstructions: instructions,
            }
          : attachment,
      ),
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-neutral-200/80 bg-neutral-50/70 p-4 dark:border-white/10 dark:bg-neutral-950/30">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase text-neutral-500">{label}</p>
          <p className="max-w-2xl text-[11px] leading-relaxed text-neutral-500">
            {helper}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_SOURCE_TYPES}
          className="hidden"
          onChange={handleFilesSelected}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full shrink-0 sm:w-auto"
          onClick={() => inputRef.current?.click()}
          disabled={!canAddFiles}
        >
          {extracting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Paperclip className="mr-2 h-4 w-4" />
          )}
          {extracting ? "Extracting" : "Attach"}
        </Button>
      </div>

      {currentFile ? (
        <p className="text-xs text-neutral-500">Reading {currentFile}...</p>
      ) : null}
      {error ? <p className="text-xs text-red-500">{error}</p> : null}

      {value.length ? (
        <div className="space-y-2">
          {value.map((attachment, index) => {
            const Icon = iconForMimeType(attachment.mimeType);
            const preview = previewText(attachment);
            return (
              <div
                key={attachment.id ?? `${attachment.name}-${index}`}
                className="flex items-start gap-3 rounded-lg border border-neutral-200/80 bg-white/80 p-3 dark:border-white/10 dark:bg-neutral-900/80"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                      {attachment.name}
                    </p>
                    <Badge variant="outline" className="text-[10px]">
                      {formatBytes(attachment.size)}
                    </Badge>
                  </div>
                  {preview ? (
                    <p className="line-clamp-2 text-xs leading-relaxed text-neutral-500">
                      {preview}
                    </p>
                  ) : null}
                  <Textarea
                    value={attachment.usageInstructions ?? ""}
                    onChange={(event) =>
                      handleUsageInstructionsChange(index, event.target.value)
                    }
                    placeholder={instructionPlaceholder}
                    className="min-h-[72px] resize-none bg-neutral-50/80 text-xs dark:bg-neutral-950/60"
                    disabled={disabled || extracting}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0 text-neutral-500 hover:text-red-500"
                  onClick={() => handleRemove(attachment.id, index)}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

async function buildAttachment(
  file: File,
  token?: string | null,
): Promise<SourceAttachmentPayload> {
  if (file.size > SOURCE_ATTACHMENT_MAX_FILE_BYTES) {
    throw new Error(
      `${file.name} is too large. Keep each source under ${SOURCE_ATTACHMENT_MAX_FILE_LABEL}.`,
    );
  }

  const id = createAttachmentId();
  const mimeType = inferMimeType(file);

  if (isTextLikeSource(file, mimeType)) {
    const text = sanitizeSourceText(
      await file.text(),
      SOURCE_ATTACHMENT_MAX_TEXT_CHARS,
    );

    if (!text) {
      throw new Error(`${file.name} does not contain readable text.`);
    }

    return {
      id,
      name: file.name,
      mimeType,
      size: file.size,
      extractedText: text,
    };
  }

  if (!isModelExtractableSource(mimeType)) {
    throw new Error(
      `${file.name} is not supported yet. Use PDF, image, TXT, MD, CSV, or JSON sources.`,
    );
  }

  const response = await fetch("/api/sources/extract", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({
      file: {
        id,
        name: file.name,
        mimeType,
        size: file.size,
        data: await fileToBase64(file),
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || `Could not extract ${file.name}.`);
  }

  return data.attachment as SourceAttachmentPayload;
}

function inferMimeType(file: File): string {
  if (file.type) {
    return file.type;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (lowerName.endsWith(".txt") || lowerName.endsWith(".log")) {
    return "text/plain";
  }
  if (lowerName.endsWith(".csv")) {
    return "text/csv";
  }
  if (lowerName.endsWith(".json")) {
    return "application/json";
  }
  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lowerName.endsWith(".png")) {
    return "image/png";
  }
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerName.endsWith(".webp")) {
    return "image/webp";
  }
  if (lowerName.endsWith(".gif")) {
    return "image/gif";
  }
  return "application/octet-stream";
}

function isTextLikeSource(file: File, mimeType: string): boolean {
  const lowerName = file.name.toLowerCase();
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".log") ||
    lowerName.endsWith(".txt")
  );
}

function isModelExtractableSource(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = value.indexOf(",");
      resolve(commaIndex >= 0 ? value.slice(commaIndex + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}

function jsonHeaders(token?: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function createAttachmentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function iconForMimeType(mimeType: string) {
  if (mimeType.startsWith("image/")) {
    return ImageIcon;
  }
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/pdf"
  ) {
    return FileText;
  }
  return FileIcon;
}

function previewText(attachment: SourceAttachmentPayload): string {
  const text = attachment.summary || attachment.extractedText;
  return text.length > 220 ? `${text.slice(0, 220).trim()}...` : text;
}

function formatBytes(size: number | undefined): string {
  if (!size || !Number.isFinite(size)) {
    return "source";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  const kilobytes = size / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`;
  }

  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}
