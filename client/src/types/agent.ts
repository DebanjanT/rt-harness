/** Mirrors server/src/types.ts — the single source of truth for the WS protocol. */

export type ToolCallApprovalKind = "command" | "file_write";

export type AgentMode = "agent" | "ask" | "plan" | "bypass";
export type ToolPermission = "auto" | "approval" | "disabled";
/** Reasoning effort for thinking-capable models (provider-dependent). */
export type ThinkingEffort = "off" | "low" | "medium" | "high" | "max";
export const THINKING_LEVELS: { id: ThinkingEffort; label: string }[] = [
  { id: "off", label: "Thinking: off" },
  { id: "low", label: "Thinking: low" },
  { id: "medium", label: "Thinking: medium" },
  { id: "high", label: "Thinking: high" },
  { id: "max", label: "Thinking: max" },
];

export interface ImageAttachment {
  name: string;
  dataUrl: string;
}

export interface ApprovalRequest {
  id: string;
  kind: ToolCallApprovalKind;
  tool: string;
  summary: string;
  data: Record<string, unknown>;
  diff?: string;
}

export type AgentEvent =
  | { type: "message.delta"; text: string }
  | { type: "message.done"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "tool.started"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool.finished"; id: string; tool: string; ok: boolean; result: string }
  | { type: "approval.required"; approval: ApprovalRequest }
  | { type: "approval.resolved"; id: string; approved: boolean }
  | { type: "file.changed"; path: string }
  | { type: "agent.started"; providerId: string; model: string }
  | { type: "agent.iteration"; iteration: number }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      requests: number;
      tokensPerSec: number;
      contextTokens: number;
      contextWindow: number | null;
    }
  | { type: "agent.finished" }
  | { type: "agent.error"; error: string }
  /** Server → client terminal stream (handled by TerminalPane directly). */
  | { type: "terminal.output"; data: string };

export type ClientMessage =
  | {
      type: "chat.user";
      text: string;
      providerId: string;
      model: string;
      attachments?: { path: string; content: string }[];
      images?: ImageAttachment[];
      mode?: AgentMode;
      toolPermissions?: Record<string, ToolPermission>;
      thinkingEffort?: ThinkingEffort;
      autoApprove?: boolean;
    }
  | { type: "chat.cancel" }
  | { type: "chat.approve"; id: string; approved: boolean; always?: boolean }
  | { type: "terminal.input"; data: string }
  | { type: "terminal.resize"; cols: number; rows: number }
  | { type: "terminal.start" };

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  /** Model accepts OpenAI-style reasoning_effort. */
  thinking: boolean;
  notes: string[];
}

export const KNOWN_TOOLS = [
  "read_file",
  "list_directory",
  "search_files",
  "write_file",
  "edit_file",
  "execute_command",
  "web_search",
  "fetch_url",
  "git_status",
  "git_diff",
  "git_log",
] as const;

export const MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: "agent", label: "Agent", hint: "Full tool access — reads, writes and runs commands (with approval)" },
  { id: "ask", label: "Ask", hint: "Answer questions only — no tools, no changes" },
  { id: "plan", label: "Plan", hint: "Investigate and produce a plan — no changes until you approve" },
  { id: "bypass", label: "Bypass", hint: "Agent with auto-approved tools — use with care" },
];
