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

    const current = await getPersona(client, id);
    if (!current) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }

    // The provider this call effectively targets (new value, or the saved one).
    const effectiveProvider =
      body.provider !== undefined ? provider : current.model_provider;

    // Custom endpoints must carry a base URL (new value, or one already saved).
    if (
      effectiveProvider === "openai_compatible" ||
      effectiveProvider === "anthropic_compatible"
    ) {
      const effectiveBaseUrl =
        baseUrl !== undefined ? baseUrl : (current.model_base_url ?? null);
      if (!effectiveBaseUrl) {
        return NextResponse.json(
          { error: `${effectiveProvider} needs a base_url (the endpoint of your gateway).` },
          { status: 400 },
        );
      }
    }

    const hasKey = typeof body.key === "string" && body.key.trim().length > 0;
    if (hasKey && !effectiveProvider) {
      return NextResponse.json(
        { error: "Set a provider before adding a key." },
        { status: 400 },
      );
    }

    // Store the key FIRST: if this fails, the persona config is left untouched
    // (no broken "provider set, no key" state on the next agent run).
    if (hasKey && effectiveProvider) {
      await setPersonaCredential(client, {
        persona_id: id,
        provider: effectiveProvider,
        key: body.key as string,
        label: typeof body.label === "string" ? body.label : null,
        created_by: userEmail,
      });
    }

    const persona = await updatePersona(client, id, {
      ...(body.provider !== undefined ? { model_provider: provider } : {}),
      ...(modelName !== undefined ? { model_name: modelName } : {}),
      ...(baseUrl !== undefined ? { model_base_url: baseUrl } : {}),
    });
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
