import "server-only";

import type { ModelProviderPreference } from "@/lib/types";

export function modelProviderKeyName(
  provider: ModelProviderPreference,
): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GEMINI_API_KEY";
    case "openai":
    default:
      return "OPENAI_API_KEY";
  }
}

export function getModelProviderApiKey(
  provider: ModelProviderPreference,
): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      return process.env.GEMINI_API_KEY;
    case "openai":
    default:
      return process.env.OPENAI_API_KEY;
  }
}

export function hasAnyModelProviderApiKey(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GEMINI_API_KEY,
  );
}

export function requireModelProviderApiKey(
  provider: ModelProviderPreference,
  laneName: string,
): string {
  const key = getModelProviderApiKey(provider);

  if (!key) {
    throw new Error(
      `${modelProviderKeyName(provider)} is required for ${laneName} when ${provider} is selected.`,
    );
  }

  return key;
}
