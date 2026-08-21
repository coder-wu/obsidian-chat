import type { AIProvider, ProviderId } from "../types";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";

export function getProvider(
  provider: ProviderId,
  opts: { openaiApiKey: string; openaiBaseURL?: string; anthropicApiKey: string; anthropicBaseURL?: string }
): AIProvider {
  switch (provider) {
    case "openai":
      return new OpenAIProvider(opts.openaiApiKey, opts.openaiBaseURL);
    case "anthropic":
      return new AnthropicProvider(opts.anthropicApiKey, opts.anthropicBaseURL);
    default:
      throw new Error("Unknown provider: " + provider);
  }
}
