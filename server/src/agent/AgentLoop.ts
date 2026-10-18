import type OpenAI from "openai";
import type { AgentEvent, AgentMode, ImageAttachment, ProviderConfig, ThinkingEffort, ToolPermission } from "../types.js";
import { createLLM } from "../llm/provider.js";
import { getConfig } from "../config.js";
import { buildSystemPrompt, buildAttachmentBlock, type ContextInput } from "./ContextBuilder.js";
import { createDefaultTools } from "../tools/index.js";
import { toOpenAITools, type Tool, type ToolContext } from "../tools/ToolRegistry.js";
import { makeDiff } from "../tools/fsTools.js";
import { parseTextToolCalls, type ParsedToolCall } from "./TextToolCallParser.js";

export type Emit = (event: AgentEvent) => void;

export interface AgentRunOptions extends ContextInput {
  provider: ProviderConfig;
  model: string;
  /** Prior conversation (assistant/user turns), already harness-side. */
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  autoApprove: boolean;
  signal: AbortSignal;
  requestApproval: ToolContext["requestApproval"];
  onFileChanged: (path: string) => void;
  /** Images uploaded from the composer (sent as image_url content parts). */
  images?: ImageAttachment[];
  /** agent (default) | ask | plan | bypass */
  mode?: AgentMode;
  /** Per-tool permission overrides from the tools config dialog. */
  toolPermissions?: Record<string, ToolPermission>;
  /** Reasoning effort for thinking-capable models (only sent if not off). */
  thinkingEffort?: ThinkingEffort;
}

interface PendingToolCall {
  id: string;
  name: string;
  argsJson: string;
}

/**
 * Detects replies where the model gives the user instructions instead of
 * performing the task itself (a common small-local-model failure mode):
 *   "you can type `touch sample.txt` into the terminal"
 *   "you can use the following command: …"
 */
export function looksLikeInstructionText(text: string): boolean {
  const patterns = [
    /you can (?:type|use|run|create|write|open|execute)/i,
    /you(?:'ll| will)? need to (?:type|use|run|create|write|open|execute)/i,
    /(?:open|switch to|in) (?:a |the )?(?:terminal|command (?:line|prompt)|shell)/i,
    /follow (?:these|the following) steps?/i,
    /to (?:create|write|add|make) (?:a |the )?(?:file|folder|directory)[^.]*,? you can/i,
    /here(?:'s| is) (?:how|the command)/i,
    /run (?:the )?(?:following|this) command/i,
  ];
  return patterns.some((re) => re.test(text));
}

/**
 * Pure greeting/small-talk detection. Tiny local models love to "helpfully"
 * read/edit files even for "hi" — a real hazard. When the user's message is
 * ONLY a greeting/small-talk phrase, the harness runs the request WITHOUT
 * tools (like ask mode) so the reply is purely conversational. Deliberately
 * conservative: only exact short phrases, never sentences with extra content.
 */
const PURE_GREETING_RE =
  /^\s*(?:hi+|hey+|hello+|yo+|sup|hiya|howdy|greetings|good\s*(?:morning|afternoon|evening)|thanks?|thank\s*you|ty|ok(?:ay)?|cool|nice|who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|can\s+you\s+help(?:\s+me)?|are\s+you\s+there)[\s!.,?]*$/i;

const TOOL_NUDGE = [
  "You replied with instructions telling ME how to do the task — that is wrong.",
  "You are an autonomous agent with REAL tools. Never describe commands for the user to run.",
  "Instead: call the write_file tool to create/modify files, read_file to read them, and execute_command to run commands.",
  "Perform the original request yourself by calling the appropriate tool NOW.",
  "(Only if the request is purely informational and needs no file/command action, repeat your final answer unchanged.)",
].join(" ");

/**
 * Streaming splitter for inline <think>…</think> blocks (Qwen3 / DeepSeek-R1
 * style). Reasoning text is routed to the thinking timeline instead of the
 * message body. Handles tags split across stream chunks.
 */
interface ThinkSplitter {
  phase: "start" | "think" | "content";
  buf: string;
}

export function splitThinkChunk(
  sp: ThinkSplitter,
  chunk: string,
): { thinking: string; content: string } {
  if (sp.phase === "content") return { thinking: "", content: chunk };

  if (sp.phase === "start") {
    sp.buf += chunk;
    const body = sp.buf.trimStart();
    if (body.startsWith("<think>")) {
      sp.phase = "think";
      sp.buf = body.slice(7);
      return splitThinkTail(sp); // process remainder after the opening tag
    }
    if (body.length < 7 && "<think>".startsWith(body)) {
      // possibly an incomplete "<think>" prefix — wait for more chunks
      return { thinking: "", content: "" };
    }
    sp.phase = "content";
    const out = sp.buf;
    sp.buf = "";
    return { thinking: "", content: out };
  }

  // think phase
  sp.buf += chunk;
  return splitThinkTail(sp);
}

/** Process the pending think-phase buffer: emit thinking, watch for </think>. */
function splitThinkTail(sp: ThinkSplitter): { thinking: string; content: string } {
  const closeIdx = sp.buf.indexOf("</think>");
  if (closeIdx !== -1) {
    const thinking = sp.buf.slice(0, closeIdx);
    const content = sp.buf.slice(closeIdx + 8);
    sp.phase = "content";
    sp.buf = "";
    return { thinking, content };
  }
  // hold back up to 8 chars in case "</think>" is split across chunks
  const hold = Math.min(8, sp.buf.length);
  const thinking = sp.buf.slice(0, sp.buf.length - hold);
  sp.buf = sp.buf.slice(sp.buf.length - hold);
  return { thinking, content: "" };
}

export function flushThink(sp: ThinkSplitter): { thinking: string; content: string } {
  const out = sp.buf;
  sp.buf = "";
  if (sp.phase === "think") return { thinking: out, content: "" };
  return { thinking: "", content: out };
}

/**
 * The agent loop:
 *   stream → accumulate content + tool_calls → execute tools → append results
 *   → repeat until the model answers without tools or we hit maxIterations.
 *
 * Tool calling works in TWO modes, auto-detected per model turn:
 *   - NATIVE: the server returned OpenAI `tool_calls` deltas (normal path).
 *   - TEXT:   the model printed tool calls in the message content
 *             (e.g. <tool.write_file>{…}</tool.write_file>). The text parser
 *             recovers them; results are fed back as user-role "TOOL RESULT"
 *             messages because the server never issued tool_call ids.
 */
export async function runAgent(opts: AgentRunOptions, emit: Emit): Promise<void> {
  const client = createLLM(opts.provider);
  const cfg = getConfig();
  const tools: Tool[] = createDefaultTools();
  const openaiTools = toOpenAITools(tools);
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const knownToolNames = [...toolByName.keys()];

  // Set once a 4xx shows the server/model can't handle the `tools` param.
  let nativeToolsUnsupported = false;
  // Set once a 4xx shows the server rejects the reasoning_effort param.
  let thinkingUnsupported = false;
  // One-time corrective re-prompt when the model gives instructions instead of
  // calling tools (e.g. "you can run: touch sample.txt").
  let nudged = false;

  // ---- usage tracking ----
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let requests = 0;
  let contextWindow: number | null = null;
  // Best-effort context-window discovery from the provider's /models payload.
  try {
    const page = await client.models.list();
    for await (const m of page) {
      if (m.id === opts.model) {
        const meta = m as unknown as Record<string, unknown>;
        for (const key of ["context_window", "context_length", "max_context_tokens", "context_size"]) {
          const v = meta[key];
          if (typeof v === "number" && v > 0) contextWindow = v;
          if (v && typeof v === "object") {
            const inner = v as Record<string, unknown>;
            if (typeof inner.input === "number") contextWindow = inner.input;
            if (typeof inner.total === "number") contextWindow = inner.total;
          }
        }
        break;
      }
    }
  } catch {
    /* provider may not expose model metadata — context % hidden in UI */
  }

  const requestedMode: AgentMode = opts.mode ?? "agent";
  // Guardrail: casual greetings never touch tools (unless the user explicitly
  // chose bypass, which implies full autonomy).
  const isPureGreeting =
    requestedMode === "agent" && !opts.attachments.length && PURE_GREETING_RE.test(opts.userText.trim());
  const mode: AgentMode = isPureGreeting ? "ask" : requestedMode;
  const useTools = mode === "agent" || mode === "bypass";
  const effectiveAutoApprove = opts.autoApprove || mode === "bypass";
  if (isPureGreeting) {
    console.log("[agent] pure greeting detected — running conversationally without tools");
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: await buildSystemPrompt(opts, mode) + buildAttachmentBlock(opts.attachments) },
    ...opts.history,
    {
      role: "user",
      // Multimodal content when images are attached (vision-capable models).
      ...(opts.images?.length
        ? {
            content: [
              { type: "text" as const, text: opts.userText || "Describe the attached image(s)." },
              ...opts.images.map((img) => ({ type: "image_url" as const, image_url: { url: img.dataUrl } })),
            ],
          }
        : { content: opts.userText }),
    },
  ];

  emit({ type: "agent.started", providerId: opts.provider.id, model: opts.model });

  /** Shared tool executor — used by both native and text paths. */
  const executeToolCall = async (callId: string, name: string, args: Record<string, unknown>) => {
    const tool = toolByName.get(name);
    if (!tool) {
      const msg = `Error: unknown tool "${name}". Available tools: ${knownToolNames.join(", ")}`;
      emit({ type: "tool.finished", id: callId, tool: name, ok: false, result: msg });
      return msg;
    }

    // Per-tool permission overrides from the tools config dialog.
    const override = opts.toolPermissions?.[tool.name];
    if (override === "disabled") {
      const msg = `Tool "${tool.name}" has been disabled by the user in the tools settings. Do not call it again; accomplish the task without it or explain what you need.`;
      emit({ type: "tool.finished", id: callId, tool: tool.name, ok: false, result: msg });
      return msg;
    }

    emit({ type: "tool.started", id: callId, tool: tool.name, args });

    const ctx: ToolContext = {
      autoApprove: effectiveAutoApprove || override === "auto",
      signal: opts.signal,
      onFileChanged: opts.onFileChanged,
      requestApproval: async (req) => {
        let diff = req.diff;
        if (
          !diff &&
          req.kind === "file_write" &&
          typeof (req.data as Record<string, unknown>)?.content === "string" &&
          typeof (req.data as Record<string, unknown>)?.path === "string"
        ) {
          try {
            const { readFile } = await import("node:fs/promises");
            const { resolveInWorkspace } = await import("../workspace/FileSystem.js");
            const before = await readFile(resolveInWorkspace(String(req.data.path)), "utf8").catch(() => "");
            diff = makeDiff(String(req.data.path), before, String(req.data.content));
          } catch {
            /* best effort */
          }
        }
        return opts.requestApproval({ ...req, diff });
      },
    };

    let result: string;
    let ok = true;
    try {
      result = await tool.execute(args, ctx);
      ok = !result.startsWith("Error") && !result.startsWith("User declined") && !result.startsWith("BLOCKED");
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      result = `Tool error: ${(err as Error).message}`;
      ok = false;
    }

    emit({ type: "tool.finished", id: callId, tool: tool.name, ok, result: result.slice(0, 4000) });
    return result;
  };

  try {
    for (let iteration = 1; iteration <= cfg.agent.maxIterations; iteration++) {
      if (opts.signal.aborted) throw new DOMException("Aborted by user", "AbortError");
      emit({ type: "agent.iteration", iteration });

      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
      const effort =
        opts.thinkingEffort && opts.thinkingEffort !== "off" && !thinkingUnsupported
          ? opts.thinkingEffort
          : null;
      try {
        // reasoning_effort is not in the SDK's chat types for all models —
        // pass it via a typed extension object while keeping the stream type.
        const createParams = {
          model: opts.model,
          messages,
          // Some servers/models reject the tools param entirely — retry without.
          ...(useTools && !nativeToolsUnsupported ? { tools: openaiTools } : {}),
          // Reasoning effort for thinking-capable models; other servers reject
          // the unknown param — degrade once (see catch) and continue without.
          ...(effort ? { reasoning_effort: effort } : {}),
          stream: true,
          // NOTE: no stream_options — many local OpenAI-compatible servers reject it.
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
        stream = await client.chat.completions.create(createParams);
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = (err as Error).message ?? "";
        if (useTools && !nativeToolsUnsupported && status === 400 && msg.toLowerCase().includes("tool")) {
          console.warn("[agent] server rejected tools param — falling back to text tool calls");
          nativeToolsUnsupported = true;
          iteration--; // retry this iteration without tools
          continue;
        }
        if (effort && status === 400 && /reasoning|effort|thinking/i.test(msg)) {
          console.warn("[agent] server rejected reasoning_effort — continuing without thinking mode");
          thinkingUnsupported = true;
          iteration--;
          continue;
        }
        if (/image|vision|multimodal/i.test(msg)) {
          emit({
            type: "agent.error",
            error:
              `The selected model "${opts.model}" does not support image input (vision). ` +
              "Remove the attached image(s) or switch to a vision-capable model.",
          });
          return;
        }
        // mlx_lm.server: its generation thread can die (commonly GPU OOM on
        // 8GB Macs after many agent-loop requests grow the prompt cache).
        // Every subsequent request 404s with "generation thread died".
        if (/generation thread died|generation thread/i.test(msg)) {
          emit({
            type: "agent.error",
            error:
              `The MLX model server's generation thread died (usually GPU out-of-memory ` +
              `on 8GB Macs — the prompt cache grows with every agent-loop request). ` +
              `Restart it with a bounded cache: npm run mlx ` +
              `(adds --prompt-cache-size 2 --max-tokens 1024 --prefill-step-size 1024), ` +
              `then try again. Alternatively switch provider/model.`,
          });
          return;
        }
        throw err;
      }

      let content = "";
      let thinking = "";
      const pendingCalls = new Map<number, PendingToolCall>();
      let providerUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
      const streamStart = Date.now();
      const thinkSp: ThinkSplitter = { phase: "start", buf: "" };

      for await (const chunk of stream) {
        if (opts.signal.aborted) {
          stream.controller.abort();
          throw new DOMException("Aborted by user", "AbortError");
        }
        // Some providers include usage on the final chunk even without stream_options.
        const chunkUsage = (chunk as unknown as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        if (chunkUsage && (chunkUsage.prompt_tokens || chunkUsage.completion_tokens)) {
          providerUsage = chunkUsage;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Separate reasoning fields (DeepSeek: reasoning_content, OpenRouter:
        // reasoning, some others: thinking).
        const d = delta as unknown as Record<string, unknown>;
        const reasoningChunk = (d.reasoning_content ?? d.reasoning ?? d.thinking) as string | undefined;
        if (reasoningChunk) {
          thinking += reasoningChunk;
          emit({ type: "thinking.delta", text: reasoningChunk });
        }

        if (delta.content) {
          // Route inline <think>…</think> blocks to the thinking timeline.
          const parts = splitThinkChunk(thinkSp, delta.content);
          if (parts.thinking) {
            thinking += parts.thinking;
            emit({ type: "thinking.delta", text: parts.thinking });
          }
          if (parts.content) {
            content += parts.content;
            emit({ type: "message.delta", text: parts.content });
          }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = pendingCalls.get(idx) ?? { id: "", name: "", argsJson: "" };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
            pendingCalls.set(idx, existing);
          }
        }
      }

      // Flush any buffered thinking (stream ended mid-think or with a held-back tail)
      const flushed = flushThink(thinkSp);
      if (flushed.thinking) {
        thinking += flushed.thinking;
        emit({ type: "thinking.delta", text: flushed.thinking });
      }
      if (flushed.content) {
        content += flushed.content;
        emit({ type: "message.delta", text: flushed.content });
      }

      // ---- Usage accounting for this request --------------------------------
      requests++;
      const elapsedSec = Math.max((Date.now() - streamStart) / 1000, 0.001);
      // Estimate: ~4 chars per token is a good approximation for code/English.
      const estimateTokens = (chars: number) => Math.ceil(chars / 4);
      const promptChars = messages.reduce((n, m) => {
        const c = m.content;
        if (typeof c === "string") return n + c.length;
        if (Array.isArray(c)) return n + c.reduce((k: number, part) => k + ((part as { text?: string }).text?.length ?? 0), 0);
        return n;
      }, 0);
      const outputChars =
        content.length +
        thinking.length +
        [...pendingCalls.values()].reduce((n, c) => n + c.name.length + c.argsJson.length, 0);
      const inputTokens = providerUsage?.prompt_tokens ?? estimateTokens(promptChars);
      const outputTokens = providerUsage?.completion_tokens ?? estimateTokens(outputChars);
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      const contextTokens = inputTokens;
      emit({
        type: "usage",
        inputTokens,
        outputTokens,
        totalInputTokens,
        totalOutputTokens,
        requests,
        tokensPerSec: Math.round(outputTokens / elapsedSec),
        contextTokens,
        contextWindow,
      });

      // ---- Resolve which tool calls to run (native first, then text parser) --
      const nativeMode = pendingCalls.size > 0;
      let parsedTextCalls: ParsedToolCall[] = [];
      let displayText = content;

      if (!nativeMode) {
        const parsed = parseTextToolCalls(content, knownToolNames);
        parsedTextCalls = parsed.calls;
        displayText = parsed.cleanedText;
      }

      // If text-tool calls were found, the cleaned prose replaces the raw
      // streamed text in the UI (removes the <tool.…> noise). Empty cleaned
      // text gets a placeholder that the next iteration replaces.
      emit({
        type: "message.done",
        text: nativeMode ? content : displayText || (parsedTextCalls.length ? "…" : content),
      });

      if (nativeMode) {
        messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: [...pendingCalls.values()].map((p, i) => ({
            id: p.id || `call_${iteration}_${i}`,
            type: "function" as const,
            function: { name: p.name, arguments: p.argsJson || "{}" },
          })),
        });
      } else if (parsedTextCalls.length > 0) {
        // Preserve what the model said (cleaned) so the conversation stays coherent.
        messages.push({ role: "assistant", content: displayText || content });
      } else {
        messages.push({ role: "assistant", content });

        // Failure mode: the model answered with advice ("you can run…")
        // instead of acting. Nudge it once and let the loop continue.
        if (
          !nudged &&
          useTools &&
          !opts.signal.aborted &&
          iteration < cfg.agent.maxIterations &&
          looksLikeInstructionText(content)
        ) {
          nudged = true;
          console.log("[agent] model gave instructions instead of tool calls — nudging");
          messages.push({ role: "user", content: TOOL_NUDGE });
          continue;
        }

        emit({ type: "agent.finished" });
        return;
      }

      // ---- Execute ----------------------------------------------------------
      if (nativeMode) {
        for (const call of pendingCalls.values()) {
          if (opts.signal.aborted) throw new DOMException("Aborted by user", "AbortError");
          const callId = call.id || `call_${iteration}_${call.name}`;
          let args: Record<string, unknown> = {};
          try {
            args = call.argsJson ? (JSON.parse(call.argsJson) as Record<string, unknown>) : {};
          } catch {
            const msg = `Error: tool arguments were not valid JSON: ${call.argsJson.slice(0, 500)}`;
            messages.push({ role: "tool", tool_call_id: callId, content: msg });
            continue;
          }
          const result = await executeToolCall(callId, call.name, args);
          messages.push({ role: "tool", tool_call_id: callId, content: result });
        }
      } else {
        // TEXT mode: no tool_call ids exist, so results go back as a user-role
        // transcript block (universally supported by local servers).
        let transcript = "";
        for (let i = 0; i < parsedTextCalls.length; i++) {
          if (opts.signal.aborted) throw new DOMException("Aborted by user", "AbortError");
          const call = parsedTextCalls[i];
          const callId = `text_${iteration}_${i}_${call.name}`;
          const result = await executeToolCall(callId, call.name, call.args);
          transcript += `[TOOL RESULT ${i + 1}: ${call.name}]\n${result}\n\n`;
        }
        transcript +=
          "Continue with the task using the results above. " +
          "Call the next tool if needed, otherwise give the final answer.";
        messages.push({ role: "user", content: transcript });
      }
    }

    emit({ type: "agent.finished" });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      emit({ type: "message.done", text: "" });
      emit({ type: "agent.finished" });
      return;
    }
    console.error("[agent] run failed:", err);
    const errMsg = (err as Error).message ?? "";
    if (/generation thread died|generation thread/i.test(errMsg)) {
      emit({
        type: "agent.error",
        error:
          `The MLX model server's generation thread died (usually GPU out-of-memory ` +
          `on 8GB Macs — the prompt cache grows with every agent-loop request). ` +
          `Restart it with a bounded cache: npm run mlx ` +
          `(adds --prompt-cache-size 2 --max-tokens 1024 --prefill-step-size 1024), ` +
          `then try again. Alternatively switch provider/model.`,
      });
      return;
    }
    emit({ type: "agent.error", error: errMsg });
  }
}
