import crypto from "node:crypto";
import type WebSocket from "ws";
import type OpenAI from "openai";
import type { AgentEvent, ApprovalRequest, ChatSummary, ClientMessage } from "../types.js";
import { getProvider, getConfig } from "../config.js";
import { runAgent } from "../agent/AgentLoop.js";
import { resolveInWorkspace } from "../workspace/FileSystem.js";
import { listChats, createChat, getChat, saveChat, deleteChat } from "../chat/ChatStore.js";
import fs from "node:fs/promises";

/**
 * One AgentSession per connected browser tab. Owns:
 *  - the active persisted chat (scoped to the workspace) + its history
 *  - pending approvals (Allow / Deny cards)
 *  - abort controller for the current run
 */
export class AgentSession {
  private chatId: string | null = null;
  private pendingApprovals = new Map<string, (result: boolean | string) => void>();
  private currentRun: AbortController | null = null;

  constructor(private ws: WebSocket) {}

  send(event: AgentEvent) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private workspace(): string {
    return getConfig().workspaceRoot;
  }

  async handle(msg: ClientMessage) {
    switch (msg.type) {
      case "chat.user":
        await this.runChat(msg);
        break;
      case "chat.cancel":
        this.currentRun?.abort();
        break;
      case "chat.new":
        this.chatId = null;
        break;
      case "chat.open": {
        if (this.currentRun) this.currentRun.abort();
        const chat = getChat(msg.id);
        if (!chat || chat.workspace !== this.workspace()) {
          this.send({ type: "agent.notice", text: "Chat not found (or it belongs to a different workspace)." });
          break;
        }
        this.chatId = chat.id;
        this.send({
          type: "chat.loaded",
          chat: { id: chat.id, workspace: chat.workspace, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt },
          entries: chat.entries,
        });
        break;
      }
      case "chat.delete": {
        if (deleteChat(msg.id)) {
          if (this.chatId === msg.id) this.chatId = null;
          this.send({ type: "chat.deleted", id: msg.id });
        }
        break;
      }
      case "chat.list":
        this.send({ type: "chat.list", chats: listChats(this.workspace()) });
        break;
      case "chat.sync":
        // The client pushes its display timeline (segments/tool cards) so a
        // reopened chat restores with full UI fidelity.
        if (msg.chatId === this.chatId) saveChat(msg.chatId, { entries: msg.entries });
        break;
      case "chat.approve": {
        const resolver = this.pendingApprovals.get(msg.id);
        if (resolver) {
          this.pendingApprovals.delete(msg.id);
          // Question approvals carry the chosen option; plain approvals resolve true/false.
          const chosen = (msg as { option?: string }).option;
          if (typeof chosen === "string") {
            (resolver as (v: boolean | string) => void)(chosen);
          } else {
            (resolver as (v: boolean | string) => void)(msg.approved);
          }
          this.send({ type: "approval.resolved", id: msg.id, approved: msg.approved });
        }
        break;
      }
      default:
        break; // terminal.* handled by TerminalManager
    }
  }

  private async runChat(msg: Extract<ClientMessage, { type: "chat.user" }>) {
    const provider = getProvider(msg.providerId);
    if (!provider) {
      this.send({ type: "agent.error", error: `Unknown provider "${msg.providerId}"` });
      return;
    }

    this.currentRun?.abort();
    const controller = new AbortController();
    this.currentRun = controller;

    // Resolve (or lazily create) the persisted chat for this conversation.
    let chat: ChatSummary | null = null;
    if (msg.chatId) {
      const loaded = getChat(msg.chatId);
      if (loaded && loaded.workspace === this.workspace()) chat = loaded;
    }
    if (!chat) {
      chat = createChat(this.workspace(), msg.text.trim() || "New chat");
      this.send({ type: "chat.created", chat });
    }
    this.chatId = chat.id;

    const attachments = (msg.attachments ?? []).filter(
      (a) => typeof a.path === "string" && typeof a.content === "string",
    );
    const images = (msg.images ?? []).filter(
      (i) => typeof i?.dataUrl === "string" && i.dataUrl.startsWith("data:image/"),
    );

    // Full-fidelity prior context (OpenAI message format) from the DB.
    const history = (getChat(chat.id)?.history ?? []) as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

    const finalMessages = await runAgent(
      {
        provider,
        model: msg.model,
        userText: msg.text,
        attachments,
        images,
        mode: msg.mode,
        toolPermissions: msg.toolPermissions,
        thinkingEffort: msg.thinkingEffort,
        history,
        autoApprove: Boolean(msg.autoApprove),
        signal: controller.signal,
        onFileChanged: (path) => this.send({ type: "file.changed", path }),
        requestApproval: (req) => this.requestApproval(req),
        requestUserInput: (req) => this.requestUserInput(req),
      },
      (event) => this.send(event),
    );

    // Persist the full exchange (minus the rebuilt system prompt) so opening
    // this chat later restores every previous message as context.
    saveChat(chat.id, { history: sanitizeHistory(finalMessages.slice(1)) });
  }

  private requestApproval(req: {
    kind: "command" | "file_write";
    tool: string;
    summary: string;
    data: Record<string, unknown>;
    diff?: string;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const approval: ApprovalRequest = { id, ...req };
      this.pendingApprovals.set(id, resolve as (v: boolean | string) => void);
      this.send({ type: "approval.required", approval });
      // If the user never answers and the run is cancelled, unblock.
      const check = setInterval(() => {
        if (!this.pendingApprovals.has(id)) {
          clearInterval(check);
          resolve(false);
        }
      }, 500);
      // Safety valve: never wait more than 5 minutes.
      setTimeout(() => {
        if (this.pendingApprovals.delete(id)) resolve(false);
        clearInterval(check);
      }, 300_000);
    });
  }

  /**
   * ask_user support: sends a question card with clickable option buttons to
   * the client and resolves with the chosen option string (or a cancellation
   * marker if the user denies / never answers).
   */
  private requestUserInput(req: {
    tool: string;
    question: string;
    options: string[];
  }): Promise<string> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const approval: ApprovalRequest = {
        id,
        kind: "question",
        tool: req.tool,
        summary: req.question,
        data: { options: req.options },
      };
      this.pendingApprovals.set(id, resolve as (v: boolean | string) => void);
      this.send({ type: "approval.required", approval });
      const check = setInterval(() => {
        if (!this.pendingApprovals.has(id)) {
          clearInterval(check);
          resolve("__cancelled__");
        }
      }, 500);
      setTimeout(() => {
        if (this.pendingApprovals.delete(id)) resolve("__cancelled__");
        clearInterval(check);
      }, 300_000);
    });
  }

  dispose() {
    this.currentRun?.abort();
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
  }
}

/**
 * Remove a trailing incomplete tool-call exchange from persisted history —
 * e.g. when a run was aborted after the assistant emitted tool_calls but
 * before all tool results were appended. Such a dangling pair would make the
 * next request invalid (OpenAI servers require tool results for every call).
 */
function sanitizeHistory(
  msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out = [...msgs];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i] as { role: string; tool_calls?: { id: string }[] };
    if (m.role === "tool") continue; // keep scanning back to the assistant
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      let j = i + 1;
      while (j < out.length && (out[j] as { role?: string }).role === "tool") j++;
      const results = j - i - 1;
      if (results < m.tool_calls.length) out.splice(i, j - i); // incomplete tail
    }
    break; // only the tail can be incomplete
  }
  return out;
}

/** Helper used by the REST API to read a file for pinning. */
export async function readWorkspaceFile(relPath: string): Promise<string> {
  return fs.readFile(resolveInWorkspace(relPath), "utf8");
}
