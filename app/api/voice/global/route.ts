import { NextResponse } from "next/server";

import {
  canEditGlobalVoice,
  emptyVoiceProfile,
  getCompetitorDomains,
  getGlobalVoiceProfile,
  isVoiceProfilePatchEmpty,
  normalizeDomainList,
  parseVoiceProfilePatch,
  upsertCompetitorDomains,
  upsertGlobalVoiceProfile,
  voiceProfilesTableMissingMessage,
} from "@/lib/voice-policy";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function GET(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const service = getSupabaseServiceClient();
    const [profile, competitorDomains] = await Promise.all([
      getGlobalVoiceProfile(service),
      getCompetitorDomains(service),
    ]);

    return NextResponse.json({
      profile: profile ?? emptyVoiceProfile(),
      competitorDomains,
      canEdit: canEditGlobalVoice(userEmail),
    });
  } catch (error) {
    const missingTables = voiceProfilesTableMissingMessage(error);
    if (missingTables) {
      return NextResponse.json({ error: missingTables }, { status: 500 });
    }

    const message = error instanceof Error ? error.message : "Unauthorized";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    if (!canEditGlobalVoice(userEmail)) {
      return NextResponse.json(
        { error: "Only voice admins can edit the global profile." },
        { status: 403 },
      );
    }

    const body = await safeReadJson(req);
    const patch = parseVoiceProfilePatch(body);

    const rawDomains = (body as Record<string, unknown>)?.competitorDomains;
    const hasCompetitorUpdate =
      Array.isArray(rawDomains) || typeof rawDomains === "string";
    const nextDomains = hasCompetitorUpdate
      ? normalizeDomainList(rawDomains)
      : null;

    if (isVoiceProfilePatchEmpty(patch) && !hasCompetitorUpdate) {
      return NextResponse.json(
        { error: "Provide at least one field to update." },
        { status: 400 },
      );
    }

    const service = getSupabaseServiceClient();

    let profile = null;
    if (!isVoiceProfilePatchEmpty(patch)) {
      profile = await upsertGlobalVoiceProfile(service, patch, {
        updatedBy: userEmail,
      });
    } else {
      profile = await getGlobalVoiceProfile(service);
    }

    let competitorDomains: string[];
    if (hasCompetitorUpdate && nextDomains) {
      competitorDomains = await upsertCompetitorDomains(service, nextDomains, {
        updatedBy: userEmail,
      });
    } else {
      competitorDomains = await getCompetitorDomains(service);
    }

    return NextResponse.json({
      profile: profile ?? emptyVoiceProfile(),
      competitorDomains,
      canEdit: true,
    });
  } catch (error) {
    const missingTables = voiceProfilesTableMissingMessage(error);
    if (missingTables) {
      return NextResponse.json({ error: missingTables }, { status: 500 });
    }

    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function safeReadJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
