import type OpenAI from "openai";
import type { AgentEvent, ProviderConfig } from "../types.js";
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

const TOOL_NUDGE = [
  "You replied with instructions telling ME how to do the task — that is wrong.",
  "You are an autonomous agent with REAL tools. Never describe commands for the user to run.",
  "Instead: call the write_file tool to create/modify files, read_file to read them, and execute_command to run commands.",
  "Perform the original request yourself by calling the appropriate tool NOW.",
  "(Only if the request is purely informational and needs no file/command action, repeat your final answer unchanged.)",
].join(" ");

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
  // One-time corrective re-prompt when the model gives instructions instead of
  // calling tools (e.g. "you can run: touch sample.txt").
  let nudged = false;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: await buildSystemPrompt(opts) + buildAttachmentBlock(opts.attachments) },
    ...opts.history,
    { role: "user", content: opts.userText },
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

    emit({ type: "tool.started", id: callId, tool: tool.name, args });

    const ctx: ToolContext = {
      autoApprove: opts.autoApprove,
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
      try {
        stream = await client.chat.completions.create({
          model: opts.model,
          messages,
          // Some servers/models reject the tools param entirely — retry without.
          ...(nativeToolsUnsupported ? {} : { tools: openaiTools }),
          stream: true,
          // NOTE: no stream_options — many local OpenAI-compatible servers reject it.
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = (err as Error).message ?? "";
        if (!nativeToolsUnsupported && status === 400 && msg.toLowerCase().includes("tool")) {
          console.warn("[agent] server rejected tools param — falling back to text tool calls");
          nativeToolsUnsupported = true;
          iteration--; // retry this iteration without tools
          continue;
        }
        throw err;
      }

      let content = "";
      const pendingCalls = new Map<number, PendingToolCall>();

      for await (const chunk of stream) {
        if (opts.signal.aborted) {
          stream.controller.abort();
          throw new DOMException("Aborted by user", "AbortError");
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          emit({ type: "message.delta", text: delta.content });
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
    emit({ type: "agent.error", error: (err as Error).message });
  }
}
