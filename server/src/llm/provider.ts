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

/** Extract the deepest useful cause chain from an OpenAI SDK / fetch error. */
function causeChain(err: unknown): string[] {
  const out: string[] = [];
  let c = (err as { cause?: unknown } | null)?.cause;
  while (c && out.length < 4) {
    const e = c as { message?: string; code?: string; cause?: unknown };
    const label = e.code ? `${e.code}${e.message ? `: ${e.message}` : ""}` : e.message;
    if (label) out.push(label);
    c = e?.cause;
  }
  return out;
}

/**
 * Turn opaque SDK/network errors ("Connection error.") into actionable agent
 * error messages. Local model servers most often die from OOM/crash mid-
 * generation or an oversized context — surface that instead of the bare SDK
 * string.
 */
export function describeLlmError(err: unknown, contextTokens?: number): string {
  const msg = (err as Error)?.message ?? String(err);
  const causes = causeChain(err);
  const all = (msg + " " + causes.join(" ")).toLowerCase();
  const causeSuffix = causes.length ? ` [${causes.join(" | ")}]` : "";

  if (/timed?\s*out|timeout/.test(all)) {
    return (
      "Request timed out — the model server accepted the connection but took too long. " +
      "Long thinking phases or slow hardware on a big model can hit the 10-minute limit; " +
      "try a smaller task, lower max output tokens, or a faster model." + causeSuffix
    );
  }
  if (/connection error|fetch failed|econnrefused|econnreset|socket hang up|epipe|other side closed|terminated|network/.test(all)) {
    return (
      `The model server dropped the connection mid-request${/connection error/i.test(msg) ? "" : ` (${msg})`}. ` +
      "This usually means the server crashed or restarted while generating — most often out of memory " +
      "or an oversized context" +
      (contextTokens
        ? ` (context was ~${Math.round(contextTokens / 1000)}k tokens — @-mention fewer/smaller files or start a new chat)`
        : "") +
      ". Check the model server's logs, then retry." + causeSuffix
    );
  }
  return causes.length ? `${msg} [cause: ${causes.join(" | ")}]` : msg;
}
