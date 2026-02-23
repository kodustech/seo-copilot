import { NextResponse } from "next/server";

import {
  generateSocialContent,
  type SocialContentSource,
  type SocialGenerationMode,
  type SocialPlatformConfigInput,
} from "@/lib/copilot";
import {
  applyVoicePolicyMode,
  resolveVoicePolicyForRequest,
  type VoicePolicyMode,
} from "@/lib/voice-policy";

export async function POST(request: Request) {
  const body = await readBody(request);

  try {
    const voiceMode = normalizeVoiceMode(body.voiceMode);
    const customTone =
      typeof body.tone === "string" ? body.tone.trim() : undefined;

    if (voiceMode === "custom" && !customTone) {
      return NextResponse.json(
        { error: "Provide a custom tone when Voice Source is set to custom." },
        { status: 400 },
      );
    }

    const resolvedPolicy = await resolveVoicePolicyForRequest(
      request.headers.get("authorization"),
    );
    const voicePolicy = applyVoicePolicyMode(
      resolvedPolicy,
      voiceMode,
      customTone,
    );

    const variations = await generateSocialContent({
      baseContent: typeof body.baseContent === "string" ? body.baseContent : "",
      instructions:
        typeof body.instructions === "string" ? body.instructions : undefined,
      language: typeof body.language === "string" ? body.language : "pt-BR",
      tone: voiceMode === "custom" ? customTone : undefined,
      variationStrategy:
        typeof body.variationStrategy === "string"
          ? body.variationStrategy
          : undefined,
      platformConfigs: normalizePlatformConfigs(body.platformConfigs),
      contentSource: normalizeContentSource(body.contentSource),
      generationMode: normalizeGenerationMode(
        body.generationMode,
        body.contentSource,
      ),
      voicePolicy,
    });
    return NextResponse.json({ posts: variations });
  } catch (error) {
    console.error("Error generating social posts", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate posts." },
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

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizePlatformConfigs(
  payload: unknown,
): SocialPlatformConfigInput[] | undefined {
  if (!Array.isArray(payload)) {
    return undefined;
  }

  const configs: SocialPlatformConfigInput[] = [];

  for (const entry of payload) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const platform =
      typeof record.platform === "string" && record.platform.trim().length > 0
        ? record.platform.trim()
        : null;

    if (!platform) continue;

    const config: SocialPlatformConfigInput = { platform };
    const maxLength = normalizeNumber(record.maxLength);
    if (typeof maxLength === "number") {
      config.maxLength = maxLength;
    }

    const numVariations = normalizeNumber(record.numVariations);
    if (typeof numVariations === "number") {
      config.numVariations = numVariations;
    }

    if (
      typeof record.linksPolicy === "string" &&
      record.linksPolicy.trim().length > 0
    ) {
      config.linksPolicy = record.linksPolicy.trim();
    }

    if (
      typeof record.ctaStyle === "string" &&
      record.ctaStyle.trim().length > 0
    ) {
      config.ctaStyle = record.ctaStyle.trim();
    }

    if (
      typeof record.hashtagsPolicy === "string" &&
      record.hashtagsPolicy.trim().length > 0
    ) {
      config.hashtagsPolicy = record.hashtagsPolicy.trim();
    }

    configs.push(config);
  }

  return configs.length ? configs : undefined;
}

function normalizeVoiceMode(raw: unknown): VoicePolicyMode {
  if (raw === "global" || raw === "user" || raw === "custom") {
    return raw;
  }
  return "auto";
}

function normalizeContentSource(raw: unknown): SocialContentSource {
  if (raw === "changelog") {
    return "changelog";
  }
  if (raw === "manual") {
    return "manual";
  }
  return "blog";
}

function normalizeGenerationMode(
  rawMode: unknown,
  rawSource: unknown,
): SocialGenerationMode {
  if (rawMode === "build_in_public" || rawMode === "content_marketing") {
    return rawMode;
  }

  if (rawSource === "changelog") {
    return "build_in_public";
  }

  return "content_marketing";
}
