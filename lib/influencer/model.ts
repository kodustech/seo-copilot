import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getModel } from "@/lib/ai/provider";
import { decryptPersonaKey } from "@/lib/crypto/persona-secrets";
import { getActiveCredentialCipher } from "@/lib/influencer/credentials";
import type { ModelProvider, Persona } from "@/lib/influencer/types";

const DEFAULT_MODELS: Record<"kimi" | "google" | "openai" | "anthropic", string> = {
  kimi: "kimi-k2.7-code",
  google: "gemini-3.0-flash-lite",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
};

/**
 * The decrypted key exists only inside this function's scope, handed straight
 * to the AI SDK client. It is never returned, logged, or exposed — and (Phase
 * C) must never be injected into an agent sandbox or reachable by a tool call.
 *
 * The `*_compatible` providers point at any OpenAI/Anthropic-compatible
 * endpoint (a subscription gateway, coding-plan endpoint, proxy, OpenRouter,
 * LiteLLM, …) via baseUrl + the persona's token.
 */
function buildModel(
  provider: ModelProvider,
  apiKey: string,
  modelName: string | null | undefined,
  baseUrl: string | null | undefined,
): LanguageModel {
  switch (provider) {
    case "kimi": {
      const kimi = createOpenAI({
        apiKey,
        baseURL: baseUrl || process.env.KIMI_BASE_URL || "https://api.moonshot.ai/v1",
        name: "kimi",
      });
      return kimi.chat(modelName || DEFAULT_MODELS.kimi);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelName || DEFAULT_MODELS.google);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(modelName || DEFAULT_MODELS.openai);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelName || DEFAULT_MODELS.anthropic);
    }
    case "openai_compatible": {
      if (!baseUrl) throw new Error("openai_compatible needs a base URL.");
      if (!modelName) throw new Error("openai_compatible needs a model name.");
      const custom = createOpenAI({ apiKey, baseURL: baseUrl, name: "custom" });
      return custom.chat(modelName);
    }
    case "anthropic_compatible": {
      if (!baseUrl) throw new Error("anthropic_compatible needs a base URL.");
      if (!modelName) throw new Error("anthropic_compatible needs a model name.");
      const custom = createAnthropic({ apiKey, baseURL: baseUrl });
      return custom(modelName);
    }
  }
}

/** Global env fallback exists only for the native providers, not custom endpoints. */
function envKeyFor(provider: ModelProvider): string | undefined {
  switch (provider) {
    case "kimi":
      return process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
    case "google":
      return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    default:
      return undefined;
  }
}

/**
 * The model a persona operates on. Precedence:
 *   1. persona.model_provider + its own stored key  → true per-persona billing
 *   2. persona.model_provider + the global env key (native providers only)
 *   3. no provider set → the global AI_PROVIDER default (unchanged behavior)
 *
 * Billing isolation: a persona on its own key/endpoint running dry pauses only
 * that persona; the rest of the fleet keeps running on their own providers.
 */
export async function getModelForPersona(
  client: SupabaseClient,
  persona: Persona,
): Promise<LanguageModel> {
  const provider = persona.model_provider;
  if (!provider) return getModel();

  const cipher = await getActiveCredentialCipher(client, persona.id, provider);
  const apiKey = cipher ? decryptPersonaKey(cipher) : envKeyFor(provider);

  if (!apiKey) {
    throw new Error(
      `Persona @${persona.handle} is set to "${provider}" but has no API key. ` +
        `Add one for the persona, or set the ${provider} key in the environment.`,
    );
  }

  return buildModel(provider, apiKey, persona.model_name, persona.model_base_url);
}
