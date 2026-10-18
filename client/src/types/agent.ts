/** Mirrors server/src/types.ts — the single source of truth for the WS protocol. */

export type ToolCallApprovalKind = "command" | "file_write";

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
  | { type: "tool.started"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool.finished"; id: string; tool: string; ok: boolean; result: string }
  | { type: "approval.required"; approval: ApprovalRequest }
  | { type: "approval.resolved"; id: string; approved: boolean }
  | { type: "file.changed"; path: string }
  | { type: "agent.started"; providerId: string; model: string }
  | { type: "agent.iteration"; iteration: number }
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
