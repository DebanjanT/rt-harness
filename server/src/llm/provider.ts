import OpenAI from "openai";
import type { ProviderConfig } from "../types.js";

/**
 * Every provider (Ollama, FreeToken, LM Studio, vLLM, OpenRouter…) is just an
 * OpenAI-compatible base URL. The harness only ever speaks OpenAI SDK.
 */
export function createLLM(provider: ProviderConfig): OpenAI {
  return new OpenAI({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey ?? "not-needed",
    // Local servers can be slow to boot a big model — be generous.
    timeout: 600_000,
    maxRetries: 2,
  });
}

/** Discover models from a provider's /v1/models endpoint. */
export async function listModels(provider: ProviderConfig): Promise<string[]> {
  try {
    const client = createLLM(provider);
    const page = await client.models.list();
    const ids: string[] = [];
    for await (const m of page) {
      if (m.id) ids.push(m.id);
    }
    return ids.sort();
  } catch (err) {
    console.warn(`[llm] model discovery failed for ${provider.id}:`, (err as Error).message);
    return provider.models ?? [];
  }
}
