import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

import {
  deletePersonaCredential,
  listPersonaCredentials,
  setPersonaCredential,
} from "@/lib/influencer/credentials";
import { getPersona, updatePersona } from "@/lib/influencer/personas";
import {
  influencerTableMissingMessage,
  normalizeModelProvider,
} from "@/lib/influencer/types";

export const maxDuration = 60;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Internal error";
  const missing = influencerTableMissingMessage(error);
  if (missing) return NextResponse.json({ error: missing }, { status: 500 });
  if (message.toLowerCase().includes("token") || message === "Unauthorized") {
    return unauthorized(message);
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;

    const persona = await getPersona(client, id);
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }
    const credentials = await listPersonaCredentials(client, id);
    return NextResponse.json({
      model_provider: persona.model_provider,
      model_name: persona.model_name,
      model_base_url: persona.model_base_url,
      credentials,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Set the persona's provider/model/endpoint, and optionally store its key. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // `null` clears the persona back to the global default provider.
    const provider =
      body.provider === null ? null : normalizeModelProvider(body.provider);
    if (body.provider !== undefined && body.provider !== null && !provider) {
      return NextResponse.json(
        { error: "provider must be one of kimi, google, openai, anthropic." },
        { status: 400 },
      );
    }

    const modelName =
      typeof body.model === "string"
        ? body.model.trim() || null
        : body.model === null
          ? null
          : undefined;

    const baseUrl =
      typeof body.base_url === "string"
        ? body.base_url.trim() || null
        : body.base_url === null
          ? null
          : undefined;

    // Custom endpoints must carry a base URL (new value, or one already saved).
    if (provider === "openai_compatible" || provider === "anthropic_compatible") {
      const current = await getPersona(client, id);
      const effectiveBaseUrl =
        baseUrl !== undefined ? baseUrl : (current?.model_base_url ?? null);
      if (!effectiveBaseUrl) {
        return NextResponse.json(
          { error: `${provider} needs a base_url (the endpoint of your gateway).` },
          { status: 400 },
        );
      }
    }

    const persona = await updatePersona(client, id, {
      ...(body.provider !== undefined ? { model_provider: provider } : {}),
      ...(modelName !== undefined ? { model_name: modelName } : {}),
      ...(baseUrl !== undefined ? { model_base_url: baseUrl } : {}),
    });
    if (!persona) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    // Optional: store the key for whichever provider this call targets.
    if (typeof body.key === "string" && body.key.trim()) {
      const keyProvider = provider ?? persona.model_provider;
      if (!keyProvider) {
        return NextResponse.json(
          { error: "Set a provider before adding a key." },
          { status: 400 },
        );
      }
      await setPersonaCredential(client, {
        persona_id: id,
        provider: keyProvider,
        key: body.key,
        label: typeof body.label === "string" ? body.label : null,
        created_by: userEmail,
      });
    }

    const credentials = await listPersonaCredentials(client, id);
    return NextResponse.json({
      model_provider: persona.model_provider,
      model_name: persona.model_name,
      credentials,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Remove a stored key for a provider (?provider=openai). */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const provider = normalizeModelProvider(
      new URL(req.url).searchParams.get("provider"),
    );
    if (!provider) {
      return NextResponse.json(
        { error: "provider query param is required." },
        { status: 400 },
      );
    }
    await deletePersonaCredential(client, id, provider);
    const credentials = await listPersonaCredentials(client, id);
    return NextResponse.json({ credentials });
  } catch (error) {
    return errorResponse(error);
  }
}
