import crypto from "node:crypto";
import type WebSocket from "ws";
import type OpenAI from "openai";
import type { AgentEvent, ApprovalRequest, ClientMessage } from "../types.js";
import { getProvider } from "../config.js";
import { runAgent } from "../agent/AgentLoop.js";
import { resolveInWorkspace } from "../workspace/FileSystem.js";
import fs from "node:fs/promises";

/**
 * One AgentSession per connected browser tab. Owns:
 *  - conversation history (in-memory, per tab)
 *  - pending approvals (Allow / Deny cards)
 *  - abort controller for the current run
 */
export class AgentSession {
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private pendingApprovals = new Map<string, (result: boolean | string) => void>();
  private currentRun: AbortController | null = null;

  constructor(private ws: WebSocket) {}

  send(event: AgentEvent) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  async handle(msg: ClientMessage) {
    switch (msg.type) {
      case "chat.user":
        await this.runChat(msg);
        break;
      case "chat.cancel":
        this.currentRun?.abort();
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

    const attachments = (msg.attachments ?? []).filter(
      (a) => typeof a.path === "string" && typeof a.content === "string",
    );
    const images = (msg.images ?? []).filter(
      (i) => typeof i?.dataUrl === "string" && i.dataUrl.startsWith("data:image/"),
    );

    await runAgent(
      {
        provider,
        model: msg.model,
        userText: msg.text,
        attachments,
        images,
        mode: msg.mode,
        toolPermissions: msg.toolPermissions,
        thinkingEffort: msg.thinkingEffort,
        history: this.history.slice(-20),
        autoApprove: Boolean(msg.autoApprove),
        signal: controller.signal,
        onFileChanged: (path) => this.send({ type: "file.changed", path }),
        requestApproval: (req) => this.requestApproval(req),
        requestUserInput: (req) => this.requestUserInput(req),
      },
      (event) => this.send(event),
    );

    // Persist the final exchange (plus a compact trace) into history.
    this.history.push({ role: "user", content: msg.text });
    // NOTE: full fidelity history including tool calls is kept by the loop;
    // for simplicity we store just the user turn here and trim old turns.
    if (this.history.length > 20) this.history = this.history.slice(-20);
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

/** Helper used by the REST API to read a file for pinning. */
export async function readWorkspaceFile(relPath: string): Promise<string> {
  return fs.readFile(resolveInWorkspace(relPath), "utf8");
}
