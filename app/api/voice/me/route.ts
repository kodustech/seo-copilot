import { NextResponse } from "next/server";

import {
  emptyVoiceProfile,
  getGlobalVoiceProfile,
  getUserVoiceProfile,
  isVoiceProfilePatchEmpty,
  mergeVoiceProfiles,
  parseVoiceProfilePatch,
  toVoicePolicyPayload,
  upsertUserVoiceProfile,
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
    const [globalProfile, userProfile] = await Promise.all([
      getGlobalVoiceProfile(service),
      getUserVoiceProfile(service, userEmail),
    ]);

    const payload = toVoicePolicyPayload({
      userEmail,
      globalProfile,
      userProfile,
    });

    return NextResponse.json({
      userEmail,
      profile: userProfile ?? emptyVoiceProfile(),
      globalProfile: globalProfile ?? emptyVoiceProfile(),
      mergedProfile: payload.mergedProfile,
      prompt: payload.prompt,
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

    const body = await safeReadJson(req);
    const patch = parseVoiceProfilePatch(body);

    if (isVoiceProfilePatchEmpty(patch)) {
      return NextResponse.json(
        { error: "Provide at least one field to update." },
        { status: 400 },
      );
    }

    const service = getSupabaseServiceClient();
    const profile = await upsertUserVoiceProfile(service, userEmail, patch);
    const globalProfile = await getGlobalVoiceProfile(service);

    return NextResponse.json({
      userEmail,
      profile,
      globalProfile: globalProfile ?? emptyVoiceProfile(),
      mergedProfile: mergeVoiceProfiles(globalProfile, profile),
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
