import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

type Provider = "google" | "openai" | "anthropic";

const DEFAULT_MODELS: Record<Provider, string> = {
  google: "gemini-2.0-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
};

export function getModel(): LanguageModel {
  const provider = (process.env.AI_PROVIDER?.toLowerCase() || "google") as Provider;

  switch (provider) {
    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
      const model = process.env.AI_MODEL_GOOGLE || DEFAULT_MODELS.google;
      return google(model);
    }
    case "openai": {
      const openai = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      const model = process.env.AI_MODEL_OPENAI || DEFAULT_MODELS.openai;
      return openai(model);
    }
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      const model = process.env.AI_MODEL_ANTHROPIC || DEFAULT_MODELS.anthropic;
      return anthropic(model);
    }
    default:
      throw new Error(
        `AI_PROVIDER "${provider}" não suportado. Use: google, openai ou anthropic.`,
      );
  }
}
