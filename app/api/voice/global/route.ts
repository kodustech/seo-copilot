import { NextResponse } from "next/server";

import {
  canEditGlobalVoice,
  emptyVoiceProfile,
  getGlobalVoiceProfile,
  isVoiceProfilePatchEmpty,
  parseVoiceProfilePatch,
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
    const profile = await getGlobalVoiceProfile(service);

    return NextResponse.json({
      profile: profile ?? emptyVoiceProfile(),
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

    if (isVoiceProfilePatchEmpty(patch)) {
      return NextResponse.json(
        { error: "Provide at least one field to update." },
        { status: 400 },
      );
    }

    const service = getSupabaseServiceClient();
    const profile = await upsertGlobalVoiceProfile(service, patch, {
      updatedBy: userEmail,
    });

    return NextResponse.json({ profile, canEdit: true });
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
