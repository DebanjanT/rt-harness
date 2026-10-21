import type OpenAI from "openai";
import type { AgentEvent, AgentMode, ImageAttachment, ProviderConfig, ThinkingEffort, ToolPermission } from "../types.js";
import { createLLM, describeLlmError } from "../llm/provider.js";
import { getConfig } from "../config.js";
import { buildSystemPrompt, buildAttachmentBlock, type ContextInput } from "./ContextBuilder.js";
import { createDefaultTools } from "../tools/index.js";
import { toOpenAITools, type Tool, type ToolContext } from "../tools/ToolRegistry.js";
import { makeDiff } from "../tools/fsTools.js";
import { parseTextToolCalls, normalizeToolArgs, type ParsedToolCall } from "./TextToolCallParser.js";

export type Emit = (event: AgentEvent) => void;

export interface AgentRunOptions extends ContextInput {
  provider: ProviderConfig;
  model: string;
  /** Prior conversation (assistant/user turns), already harness-side. */
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  autoApprove: boolean;
  signal: AbortSignal;
  requestApproval: ToolContext["requestApproval"];
  /** ask_user tool: forwards a question + options to the client, resolves with the chosen answer. */
  requestUserInput: NonNullable<ToolContext["requestUserInput"]>;
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

/** Workspace-relative paths a tool MAY mutate (for change tracking). */
function mutationPaths(toolName: string, args: Record<string, unknown>): string[] {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  switch (toolName) {
    case "write_file":
    case "edit_file":
    case "delete_file":
      return [str(args.path)].filter((p): p is string => Boolean(p));
    case "move_file":
      return [str(args.from), str(args.to)].filter((p): p is string => Boolean(p));
    default:
      return [];
  }
}

const TOOL_NUDGE = [
  "You replied with instructions telling ME how to do the task — that is wrong.",
  "You are an autonomous agent with REAL tools. Never describe commands for the user to run.",
  "Instead: call the write_file tool to create/modify files, read_file to read them, and execute_command to run commands.",
  "Perform the original request yourself by calling the appropriate tool NOW.",
  "(Only if the request is purely informational and needs no file/command action, repeat your final answer unchanged.)",
].join(" ");

/** Rough token estimate: ~4 chars per token for code/English. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** Estimated prompt size in tokens (text parts only — image dataUrls would over-count). */
function promptTokensOf(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
  return estimateTokens(
    messages.reduce((n, m) => {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") return n + c.length;
      if (Array.isArray(c)) {
        return (
          n +
          c.reduce((k: number, part) => {
            const p = part as { type?: string; text?: string };
            return k + (p.type === "text" && p.text ? p.text.length : 0);
          }, 0)
        );
      }
      return n;
    }, 0),
  );
}

/**
 * Compaction summarizer: compresses the oldest conversation messages into a
 * terse brief the agent can continue from. Returns null on failure — the
 * caller then falls back to hard trimming.
 */
async function summarizeForCompaction(
  client: OpenAI,
  model: string,
  msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const transcript = msgs
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((p) => (p as { text?: string }).text ?? "").join(" ")
              : "";
        return `[${m.role}] ${text.slice(0, 4000)}`;
      })
      .join("\n\n")
      .slice(0, 48_000);
    const res = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: "system",
            content:
              "You compress a coding agent's older conversation into a terse brief that lets it continue the task seamlessly. " +
              "Keep: the user's goal, decisions made, files created/modified (with paths), important errors and their fixes, " +
              "and the exact current step. Bullet points, under 400 words, no padding.",
          },
          { role: "user", content: transcript },
        ],
        max_tokens: 800,
        stream: false,
      },
      { signal },
    );
    const text = (res as OpenAI.Chat.Completions.ChatCompletion).choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.warn("[agent] compaction summary request failed:", (err as Error).message);
    return null;
  }
}

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
 * Streaming guard for TEXT-mode tool calls: once the model starts emitting a
 * `<tool…>` tag, suppress the raw JSON from message.delta (it floods the chat
 * and re-renders Markdown on every chunk — the "frozen chat" effect) and let
 * the caller emit throttled tool.progress events instead. The final cleaned
 * text arrives via message.done, which the client swaps in place.
 *
 * Chunks that merely *end* with a partial "<tool"/"<|tool" prefix are held
 * back (a few chars) so the tag is never partially shown.
 */
const TOOL_TAG_PREFIXES = ["<tool_", "<tool.", "<tool:", "<tool>", "<tool ", "<|tool"] as const;

export function createToolTextGuard() {
  let hidden = false;
  let hiddenChars = 0;
  let tail = "";
  return {
    feed(chunk: string): { show: string; progress: number; tool: string | null; raw: string | null } {
      if (hidden) {
        tail += chunk;
        hiddenChars += chunk.length;
        return { show: "", progress: hiddenChars, tool: toolName(tail), raw: tail };
      }
      tail += chunk;
      let idx = -1;
      for (const p of TOOL_TAG_PREFIXES) {
        const i = tail.indexOf(p);
        if (i !== -1 && (idx === -1 || i < idx)) idx = i;
      }
      if (idx !== -1) {
        const show = tail.slice(0, idx);
        hidden = true;
        hiddenChars = tail.length - idx;
        tail = tail.slice(idx);
        return { show, progress: hiddenChars, tool: toolName(tail), raw: tail };
      }
      // Hold back a trailing partial prefix (e.g. "<to") in case the tag
      // continues in the next chunk.
      let hold = 0;
      for (const p of TOOL_TAG_PREFIXES) {
        for (let l = Math.min(p.length - 1, tail.length); l > hold; l--) {
          if (tail.endsWith(p.slice(0, l))) {
            hold = l;
            break;
          }
        }
      }
      const show = tail.slice(0, tail.length - hold);
      tail = tail.slice(tail.length - hold);
      return { show, progress: 0, tool: null, raw: null };
    },
  };
}

/** Best-effort tool-name extraction from a held `<tool…` tag head. */
function toolName(head: string): string | null {
  const m = /<tool(?:_call|_calls|call)?[.:]?\s*\.?\s*([A-Za-z_][\w.]*)/.exec(head);
  return m ? m[1]!.replace(/[.].*$/, "") : null;
}

/**
 * Decode a JSON string value that may still be mid-stream (trailing escape
 * sequences stripped; parse failures yield null).
 */
function decodePartialJsonString(raw: string): string | null {
  if (!raw) return null;
  const trailingBackslashes = /\\+$/.exec(raw)?.[0].length ?? 0;
  const cut = trailingBackslashes % 2 === 1 ? raw.length - 1 : raw.length;
  try {
    return JSON.parse('"' + raw.slice(0, cut) + '"') as string;
  } catch {
    return null;
  }
}

/**
 * Extract a live write preview from partially-streamed tool arguments:
 * the target path (once complete) and the growing file content. Powers the
 * "✍ writing src/App.tsx…" live card in the UI so large edits are visible
 * WHILE the model generates them instead of popping up after the fact.
 */
export function extractWritePreview(raw: string): { path?: string; preview?: string } {
  const out: { path?: string; preview?: string } = {};
  const pathM = /"path"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (pathM) {
    try {
      out.path = JSON.parse('"' + pathM[1] + '"') as string;
    } catch {
      /* ignore malformed */
    }
  }
  const contentM =
    /"(?:content|new_text)"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw) ?? // complete value
    /"(?:content|new_text)"\s*:\s*"((?:\\.|[^"\\])*)$/.exec(raw); // still streaming
  if (contentM) {
    const decoded = decodePartialJsonString(contentM[1]);
    if (decoded && decoded.length > 40) {
      out.preview =
        decoded.length > 6000
          ? decoded.slice(0, 2000) +
            `\n… [streaming — ${decoded.length} chars so far] …\n` +
            decoded.slice(-3000)
          : decoded;
    }
  }
  return out;
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
export async function runAgent(
  opts: AgentRunOptions,
  emit: Emit,
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
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
  // Set once a 4xx shows the server rejects stream_options (usage in streams).
  let streamUsageUnsupported = false;
  // Set once a 4xx shows the server rejects chat_template_kwargs.
  let templateKwargsUnsupported = false;
  // One-time corrective re-prompt when the model gives instructions instead of
  // calling tools (e.g. "you can run: touch sample.txt").
  let nudged = false;
  /** Context size (prompt tokens) of the most recent request — for diagnostics. */
  let lastContextTokens = 0;
  /** Sent once per run when the context guard has to trim history. */
  let contextNoticeSent = false;
  /** Number of LLM-based compactions performed during this run. */
  let contextCompactions = 0;

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
  const executeToolCall = async (callId: string, name: string, rawArgs: Record<string, unknown>) => {
    // Lift alias keys (file/file_path/… → path) for BOTH native and text-mode
    // calls — small models frequently use the wrong arg name.
    const args = normalizeToolArgs(rawArgs);
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

    // ---- File-change tracking --------------------------------------------
    // Snapshot every path the tool MAY mutate before execution, compare after,
    // and record a change entry so the UI can show diffs and undo. Works for
    // all fs tools generically (including execute_command — no path tracking
    // there, but write/edit/delete/move cover the model's mutation surface).
    const snapshotPaths = mutationPaths(tool.name, args);
    const before = new Map<string, string | null>();
    if (snapshotPaths.length) {
      const { resolveInWorkspace } = await import("../workspace/FileSystem.js");
      const { readIfExists } = await import("./RunState.js");
      for (const p of snapshotPaths) {
        before.set(p, await readIfExists(resolveInWorkspace(p)));
      }
    }

    const ctx: ToolContext = {
      autoApprove: effectiveAutoApprove || override === "auto",
      signal: opts.signal,
      onFileChanged: opts.onFileChanged,
      requestUserInput: (req) => opts.requestUserInput(req),
      emit: (event) => emit(event as AgentEvent),
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

    // ---- Record file changes (after successful mutating tools) ------------
    if (ok && snapshotPaths.length) {
      const { resolveInWorkspace } = await import("../workspace/FileSystem.js");
      const { recordFileChange, readIfExists } = await import("./RunState.js");

      // Renames: from vanished + to appeared → record as one "renamed" change.
      if (tool.name === "move_file" && snapshotPaths.length === 2) {
        const [fromP, toP] = snapshotPaths;
        const fromBefore = before.get(fromP) ?? null;
        const fromAfter = await readIfExists(resolveInWorkspace(fromP));
        const toBefore = before.get(toP) ?? null;
        const toAfter = await readIfExists(resolveInWorkspace(toP));
        if (fromBefore !== null && fromAfter === null && toAfter !== null) {
          const change = recordFileChange({
            path: toP, fromPath: fromP, kind: "renamed", before: fromBefore, after: toAfter,
          });
          if (change) {
            emit({
              type: "file.change",
              change: { id: change.id, path: change.path, fromPath: change.fromPath, kind: change.kind, added: change.added, removed: change.removed },
            });
          }
        } else {
          for (const p of snapshotPaths) {
            const bc = before.get(p) ?? null;
            const ac = await readIfExists(resolveInWorkspace(p));
            if (bc === ac) continue;
            const kind: "created" | "modified" | "deleted" = bc === null ? "created" : ac === null ? "deleted" : "modified";
            const change = recordFileChange({ path: p, kind, before: bc, after: ac });
            if (change) {
              emit({ type: "file.change", change: { id: change.id, path: change.path, kind: change.kind, added: change.added, removed: change.removed } });
            }
          }
        }
      } else {
        for (const p of snapshotPaths) {
          const beforeContent = before.get(p) ?? null;
          const afterContent = await readIfExists(resolveInWorkspace(p));
          if (beforeContent === afterContent) continue;
          const kind: "created" | "modified" | "deleted" =
            beforeContent === null ? "created" : afterContent === null ? "deleted" : "modified";
          const change = recordFileChange({ path: p, kind, before: beforeContent, after: afterContent });
          if (change) {
            emit({
              type: "file.change",
              change: { id: change.id, path: change.path, kind: change.kind, added: change.added, removed: change.removed },
            });
          }
        }
      }
    }

    emit({ type: "tool.finished", id: callId, tool: tool.name, ok, result: result.slice(0, 4000) });
    return result;
  };

  try {
    for (let iteration = 1; iteration <= cfg.agent.maxIterations; iteration++) {
      if (opts.signal.aborted) throw new DOMException("Aborted by user", "AbortError");
      emit({ type: "agent.iteration", iteration });

      // ---- Context-window guard ------------------------------------------
      // The prompt must fit the model's context window (discovered from the
      // provider's /models metadata). If it overflows, drop the OLDEST
      // history messages — keeping assistant tool_calls/tool-result pairing
      // intact — and tell the user what happened and what to do about it.
      // ---- Context guard: reserve output, compact early, trim last ----------
      if (contextWindow && contextWindow > 0) {
        // The window holds input AND generated tokens — reserve room for the
        // model's output plus a safety margin before managing the input side.
        const inputBudget = Math.max(2048, contextWindow - cfg.agent.maxOutputTokens - 1024);
        // Start compaction EARLY (~80% of usable input) instead of waiting for
        // a hard failure — summarization needs headroom to work with.
        const softLimit = Math.round(inputBudget * 0.8);
        const promptTokensNow = () => promptTokensOf(messages);
        let preTokens = promptTokensNow();

        // -- 1. Early COMPACTION: summarize the oldest messages instead of
        //       deleting them. Recent messages are always kept verbatim.
        const KEEP_RECENT = 8;
        if (preTokens > softLimit && messages.length > KEEP_RECENT + 3) {
          let cutoff = messages.length - KEEP_RECENT;
          // The kept region must not start with an orphaned tool result.
          while (cutoff > 1 && (messages[cutoff] as { role?: string }).role === "tool") cutoff++;
          if (cutoff > 1) {
            const removed = cutoff - 1;
            const summary = await summarizeForCompaction(
              client, opts.model, messages.slice(1, cutoff), opts.signal,
            );
            if (summary && !opts.signal.aborted) {
              messages.splice(1, cutoff - 1, {
                role: "user",
                content:
                  `[Conversation compacted by the harness — ${removed} older message(s) were ` +
                  `replaced with this summary; treat it as memory of the earlier work]\n` +
                  summary,
              });
              const afterTokens = promptTokensNow();
              console.log(
                `[agent] context compaction: ${removed} messages → ${summary.length}-char summary ` +
                `(prompt ~${preTokens} → ~${afterTokens} tokens)`,
              );
              emit({
                type: "agent.notice",
                text:
                  `Context compaction: the prompt reached ~${Math.round(preTokens / 1000)}k tokens ` +
                  `(model window ${Math.round(contextWindow! / 1000)}k). The ${removed} oldest message(s) were ` +
                  `replaced with a short summary so the run can continue — recent messages and the current task are untouched.`,
              });
              preTokens = afterTokens;
              contextCompactions++;
            }
          }
        }

        // -- 2. Hard-trim safety net: only if still over the real budget
        //       (compaction failed, or a single huge message blocks it).
        //       The compaction summary is the LAST thing dropped — it packs
        //       the most task state per token.
        let trimmed = 0;
        const isSummaryMsg = (m: unknown) =>
          typeof (m as { content?: string }).content === "string" &&
          ((m as { content?: string }).content ?? "").startsWith("[Conversation compacted by the harness");
        while (promptTokensNow() > inputBudget && messages.length > 2) {
          // Prefer dropping the oldest non-summary message.
          let i = 1;
          while (i < messages.length - 1 && isSummaryMsg(messages[i])) i++;
          const first = messages[i] as { role?: string; tool_calls?: unknown[] };
          if (first?.role === "assistant" && Array.isArray(first.tool_calls) && first.tool_calls.length > 0) {
            let j = i + 1;
            while (j < messages.length && (messages[j] as { role?: string }).role === "tool") j++;
            messages.splice(i, j - i);
          } else {
            messages.splice(i, 1);
          }
          trimmed++;
        }
        lastContextTokens = promptTokensNow();
        if (trimmed > 0 && !contextNoticeSent) {
          contextNoticeSent = true;
          console.log(`[agent] context guard: trimmed ${trimmed} oldest message(s) to fit ${contextWindow}-token window`);
          emit({
            type: "agent.notice",
            text:
              `Context guard: this chat reached ~${Math.round(preTokens / 1000)}k tokens, over the model's ` +
              `${Math.round(contextWindow! / 1000)}k-token window. ${trimmed} oldest message(s) were trimmed ` +
              `so the run can continue — the model may have forgotten those earlier details. ` +
              `For a clean slate use "＋ New chat"; to keep more history, @-mention fewer files or switch to a larger-context model.`,
          });
        }
      }

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
          // Thinking models burn hundreds of tokens on reasoning BEFORE any
          // visible output — the mlx_lm.server default (512) dies mid-think
          // with finish_reason=length. Give a generous budget.
          max_tokens: cfg.agent.maxOutputTokens,
          // Some servers/models reject the tools param entirely — retry without.
          ...(useTools && !nativeToolsUnsupported ? { tools: openaiTools } : {}),
          // Reasoning effort for thinking-capable models; other servers reject
          // the unknown param — degrade once (see catch) and continue without.
          ...(effort ? { reasoning_effort: effort } : {}),
          // Qwen3-style chat-template switch: models with enable_thinking in
          // their template toggle reasoning on/off here. Sent ALWAYS (on when
          // effort != off, off otherwise) so "off" truly disables thinking.
          ...(!templateKwargsUnsupported
            ? { chat_template_kwargs: { enable_thinking: effort !== null } }
            : {}),
          // Request real token counts in the stream (mlx/OpenAI support this;
          // servers that reject it degrade once via the catch below).
          ...(streamUsageUnsupported ? {} : { stream_options: { include_usage: true } }),
          stream: true,
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
        if (!streamUsageUnsupported && status === 400 && /stream_options|include_usage/i.test(msg)) {
          console.warn("[agent] server rejected stream_options — falling back to estimated usage");
          streamUsageUnsupported = true;
          iteration--;
          continue;
        }
        if (!templateKwargsUnsupported && status === 400 && /chat_template|template_kwargs|enable_thinking/i.test(msg)) {
          console.warn("[agent] server rejected chat_template_kwargs — continuing without template switch");
          templateKwargsUnsupported = true;
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
          return messages;
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
          return messages;
        }
        throw err;
      }

      let content = "";
      let thinking = "";
      const pendingCalls = new Map<number, PendingToolCall>();
      let providerUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
      const streamStart = Date.now();
      const thinkSp: ThinkSplitter = { phase: "start", buf: "" };
      const toolTextGuard = createToolTextGuard();
      let lastProgressEmit = 0;

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
            // Suppress raw text-mode tool-call JSON from the chat (floods and
            // freezes the UI); surface throttled progress + a live write
            // preview instead.
            const shown = toolTextGuard.feed(parts.content);
            if (shown.show) emit({ type: "message.delta", text: shown.show });
            if (shown.progress > 0 && Date.now() - lastProgressEmit >= 400) {
              lastProgressEmit = Date.now();
              const prev = shown.raw ? extractWritePreview(shown.raw) : {};
              emit({
                type: "tool.progress",
                tool: shown.tool ?? "tool call",
                chars: shown.progress,
                ...prev,
              });
            }
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
          // Native tool-call args stream invisibly — show live progress so
          // the UI never looks frozen while a big write_file is generated.
          if (Date.now() - lastProgressEmit >= 400) {
            lastProgressEmit = Date.now();
            const calls = [...pendingCalls.values()];
            const names = [...new Set(calls.map((c) => c.name).filter(Boolean))].join(", ");
            const prev = extractWritePreview(calls.map((c) => c.argsJson).join(","));
            emit({
              type: "tool.progress",
              tool: names || "tool",
              chars: calls.reduce((n, c) => n + c.argsJson.length, 0),
              ...prev,
            });
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
        const shown = toolTextGuard.feed(flushed.content);
        if (shown.show) emit({ type: "message.delta", text: shown.show });
      }

      // Debug aid: confirms thinking/content mapping is wired correctly.
      // Watch the harness server log — reasoning chars > 0 means the model's
      // reasoning field is being captured.
      console.log(
        `[agent] req#${requests + 1} effort=${effort ?? "off"} reasoning=${thinking.length}c content=${content.length}c`,
      );

      // ---- Usage accounting for this request --------------------------------
      requests++;
      const elapsedSec = Math.max((Date.now() - streamStart) / 1000, 0.001);
      const promptChars = promptTokensOf(messages) * 4; // inverse of the shared estimator
      const outputChars =
        content.length +
        thinking.length +
        [...pendingCalls.values()].reduce((n, c) => n + c.name.length + c.argsJson.length, 0);
      const inputTokens = providerUsage?.prompt_tokens ?? estimateTokens(promptChars);
      const outputTokens = providerUsage?.completion_tokens ?? estimateTokens(outputChars);
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      const contextTokens = inputTokens;
      lastContextTokens = contextTokens;
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
        return messages;
      }

      // ---- Execute ----------------------------------------------------------
      // PARALLEL strategy: auto-permission tools run concurrently (Promise.all
      // — e.g. several read_file calls resolve together); approval-gated tools
      // run sequentially so their Allow/Deny cards queue predictably in the UI.
      if (nativeMode) {
        const calls = [...pendingCalls.values()];
        const results = new Map<string, string>();

        const parseArgs = (call: PendingToolCall) => {
          try {
            return call.argsJson ? (JSON.parse(call.argsJson) as Record<string, unknown>) : {};
          } catch {
            return null;
          }
        };

        const isAuto = (name: string) => {
          const t = toolByName.get(name);
          const override = opts.toolPermissions?.[name];
          if (override) return override === "auto";
          return t?.permission === "auto";
        };

        // Phase 1: all auto tools in parallel.
        const autoCalls = calls.filter((c) => isAuto(c.name));
        await Promise.all(
          autoCalls.map(async (call) => {
            const callId = call.id || `call_${iteration}_${call.name}`;
            const args = parseArgs(call) ?? {};
            const result = await executeToolCall(callId, call.name, args);
            results.set(callId, result);
          }),
        );

        // Phase 2: approval-gated tools sequentially (keeps approval cards ordered).
        const gatedCalls = calls.filter((c) => !isAuto(c.name));
        for (const call of gatedCalls) {
          if (opts.signal.aborted) throw new DOMException("Aborted by user", "AbortError");
          const callId = call.id || `call_${iteration}_${call.name}`;
          const args = parseArgs(call);
          if (args === null) {
            const msg = `Error: tool arguments were not valid JSON: ${call.argsJson.slice(0, 500)}`;
            messages.push({ role: "tool", tool_call_id: callId, content: msg });
            continue;
          }
          const result = await executeToolCall(callId, call.name, args);
          results.set(callId, result);
        }

        // Append tool results in the ORIGINAL request order (some servers care).
        for (const call of calls) {
          const callId = call.id || `call_${iteration}_${call.name}`;
          const args = parseArgs(call);
          const content2 =
            args === null
              ? `Error: tool arguments were not valid JSON: ${call.argsJson.slice(0, 500)}`
              : (results.get(callId) ?? "");
          messages.push({ role: "tool", tool_call_id: callId, content: content2 });
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
    return messages;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      emit({ type: "message.done", text: "" });
      emit({ type: "agent.finished" });
      return messages;
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
      return messages;
    }
    emit({ type: "agent.error", error: describeLlmError(err, lastContextTokens) });
    return messages;
  }
}
