/**
 * rt-harness agent protocol.
 *
 * The client only ever speaks this event vocabulary — it never talks to the
 * model server directly, so providers are fully swappable.
 */

export type ToolCallApprovalKind = "command" | "file_write";

export interface ApprovalRequest {
  id: string;
  kind: ToolCallApprovalKind;
  tool: string;
  /** For commands: the shell command. For writes: target path. */
  summary: string;
  /** Full payload the model produced (command string, or {path, newContent}). */
  data: Record<string, unknown>;
  /** Unified diff for file writes (empty for commands). */
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
      /** Tokens reported by the provider (stream_options.usage), when available. */
      inputTokens: number;
      outputTokens: number;
      /** Cumulative for the whole agent run. */
      totalInputTokens: number;
      totalOutputTokens: number;
      /** Requests made in this run. */
      requests: number;
      /** Observed output tokens/sec over the last request. */
      tokensPerSec: number;
      /** Estimated tokens of the outgoing context (prompt) for this request. */
      contextTokens: number;
      /** Model's context window when the provider reports one (else null). */
      contextWindow: number | null;
    }
  | { type: "agent.finished" }
  | { type: "agent.error"; error: string };

/** Messages sent by the client over the WebSocket. */
export type AgentMode = "agent" | "ask" | "plan" | "bypass";
export type ToolPermission = "auto" | "approval" | "disabled";
/** Reasoning effort for thinking-capable models (provider-dependent). */
export type ThinkingEffort = "off" | "low" | "medium" | "high" | "max";

export interface ImageAttachment {
  name: string;
  /** data: URL (base64) — sent to the model as an image_url content part. */
  dataUrl: string;
}

export type ClientMessage =
  | {
      type: "chat.user";
      text: string;
      providerId: string;
      model: string;
      /** Context files the user pinned/@-mentioned: [{path, content}] */
      attachments?: { path: string; content: string }[];
      /** Images uploaded in the composer (vision-capable models only). */
      images?: ImageAttachment[];
      /** Interaction mode: agent (tools) / ask (no tools) / plan (plan only) / bypass (tools + auto-approve). */
      mode?: AgentMode;
      /** Per-tool permission overrides from the tools config dialog. */
      toolPermissions?: Record<string, ToolPermission>;
      /** Reasoning effort for thinking-capable models (sent only if supported). */
      thinkingEffort?: ThinkingEffort;
      autoApprove?: boolean;
    }
  | { type: "chat.cancel" }
  | { type: "chat.approve"; id: string; approved: boolean; always?: boolean }
  | { type: "terminal.input"; data: string }
  | { type: "terminal.resize"; cols: number; rows: number }
  | { type: "terminal.start" };

export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  /** Optional static list; runtime discovery via /v1/models takes precedence. */
  models?: string[];
}

export interface HarnessConfig {
  workspaceRoot: string;
  providers: ProviderConfig[];
  agent: {
    maxIterations: number;
    maxFileReadChars: number;
    maxSearchResults: number;
    /** Per-request output budget — thinking models burn hundreds of tokens
     *  on reasoning before any visible output. */
    maxOutputTokens: number;
  };
  /** Recently opened workspace roots (most recent first) — for the picker modal. */
  recentWorkspaces?: string[];
}
