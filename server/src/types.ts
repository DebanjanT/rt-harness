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
  | { type: "tool.started"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool.finished"; id: string; tool: string; ok: boolean; result: string }
  | { type: "approval.required"; approval: ApprovalRequest }
  | { type: "approval.resolved"; id: string; approved: boolean }
  | { type: "file.changed"; path: string }
  | { type: "agent.started"; providerId: string; model: string }
  | { type: "agent.iteration"; iteration: number }
  | { type: "agent.finished" }
  | { type: "agent.error"; error: string };

/** Messages sent by the client over the WebSocket. */
export type ClientMessage =
  | {
      type: "chat.user";
      text: string;
      providerId: string;
      model: string;
      /** Context files the user pinned in the UI: [{path, content}] */
      attachments?: { path: string; content: string }[];
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
  };
}
