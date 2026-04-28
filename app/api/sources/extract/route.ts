import { generateObject, type UserContent } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getModel } from "@/lib/ai/provider";
import {
  sanitizeSourceText,
  SOURCE_ATTACHMENT_MAX_FILE_BYTES,
  SOURCE_ATTACHMENT_MAX_FILE_LABEL,
  SOURCE_ATTACHMENT_MAX_TEXT_CHARS,
  type SourceAttachmentPayload,
} from "@/lib/source-attachments";

const ExtractedSourceSchema = z.object({
  summary: z
    .string()
    .describe("A compact summary of the source, with no invented facts."),
  extractedText: z
    .string()
    .describe(
      "The useful source content for writing: claims, numbers, quotes, caveats, methods, labels, and visible text.",
    ),
});

export async function POST(request: Request) {
  const body = await readBody(request);
  const file = body && typeof body === "object" ? body.file : null;

  if (!file || typeof file !== "object") {
    return NextResponse.json(
      { error: "Send one file to extract." },
      { status: 400 },
    );
  }

  const record = file as Record<string, unknown>;
  const name = readString(record, "name") || "source";
  const mimeType = normalizeMimeType(readString(record, "mimeType"), name);
  const data = stripDataUrlPrefix(readString(record, "data"));
  const size = readNumber(record, "size");
  const id = readString(record, "id");

  if (!data) {
    return NextResponse.json(
      { error: "File data is missing." },
      { status: 400 },
    );
  }

  if (!isModelExtractableMime(mimeType)) {
    return NextResponse.json(
      {
        error:
          "Unsupported file type. Use PDF, image, TXT, MD, CSV, or JSON sources.",
      },
      { status: 400 },
    );
  }

  const estimatedBytes = estimateBase64Bytes(data);
  if (
    (size && size > SOURCE_ATTACHMENT_MAX_FILE_BYTES) ||
    estimatedBytes > SOURCE_ATTACHMENT_MAX_FILE_BYTES
  ) {
    return NextResponse.json(
      {
        error: `File is too large. Keep each source under ${SOURCE_ATTACHMENT_MAX_FILE_LABEL}.`,
      },
      { status: 400 },
    );
  }

  try {
    const content: UserContent = [
      {
        type: "text",
        text: buildExtractionPrompt(name, mimeType),
      },
      mimeType.startsWith("image/")
        ? {
            type: "image",
            image: data,
            mediaType: mimeType,
          }
        : {
            type: "file",
            data,
            mediaType: mimeType,
            filename: name,
          },
    ];

    const { object } = await generateObject({
      model: getModel(),
      schema: ExtractedSourceSchema,
      messages: [{ role: "user", content }],
    });

    const extractedText = sanitizeSourceText(
      object.extractedText,
      SOURCE_ATTACHMENT_MAX_TEXT_CHARS,
    );

    if (!extractedText) {
      throw new Error("The model did not extract useful text from the file.");
    }

    const attachment: SourceAttachmentPayload = {
      id: id || `source-${Date.now()}`,
      name,
      mimeType,
      size,
      summary: sanitizeSourceText(object.summary, 1_200) || undefined,
      extractedText,
    };

    return NextResponse.json({ attachment });
  } catch (error) {
    console.error("Error extracting source attachment", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "We could not extract that source.",
      },
      { status: 400 },
    );
  }
}

async function readBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

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

function stripDataUrlPrefix(value: string): string {
  const commaIndex = value.indexOf(",");
  if (value.startsWith("data:") && commaIndex >= 0) {
    return value.slice(commaIndex + 1).trim();
  }
  return value;
}

function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function normalizeMimeType(mimeType: string, name: string): string {
  if (mimeType) {
    return mimeType;
  }

  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".pdf")) return "application/pdf";
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function isModelExtractableMime(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

function buildExtractionPrompt(name: string, mimeType: string): string {
  return `Extract source material from this file for a content-writing workflow.

File: ${name}
MIME type: ${mimeType}

Return only grounded information from the file. Do not add outside context.
For PDFs, capture the thesis, key claims, methods, numbers, named entities, caveats, and any short quotes that would be useful as citations.
For images, extract visible text and describe relevant visual evidence without guessing hidden context.
Keep the extractedText dense and useful. If the file has no useful content, say that directly in extractedText.`;
}
