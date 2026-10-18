import { create } from "zustand";
import type { ApprovalRequest, ProviderInfo } from "../types/agent";
import { harnessSocket } from "../lib/websocket";
import { api } from "../lib/api";

export interface ToolStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result?: string;
}

export interface ChatEntry {
  role: "user" | "assistant";
  text: string;
  steps: ToolStep[];
  streaming?: boolean;
  error?: string;
}

export interface PendingApproval extends ApprovalRequest {
  resolved?: "approved" | "denied";
}

interface ChatState {
  entries: ChatEntry[];
  running: boolean;
  iteration: number;
  /** Length of the last assistant message when the current agent iteration began. */
  iterationTextStart: number;
  pendingApprovals: PendingApproval[];
  providers: ProviderInfo[];
  providerId: string;
  model: string;
  autoApprove: boolean;
  pinnedPaths: string[];
  input: string;
  loaded: boolean;

  init: () => Promise<void>;
  setInput: (v: string) => void;
  setProvider: (id: string) => void;
  setModel: (m: string) => void;
  toggleAutoApprove: () => void;
  togglePin: (path: string) => void;
  send: (text: string, attachments: { path: string; content: string }[]) => void;
  cancel: () => void;
  resolveApproval: (id: string, approved: boolean) => void;
  handleEvent: (event: import("../types/agent").AgentEvent) => void;
}

function updateLastAssistant(
  entries: ChatEntry[],
  fn: (e: ChatEntry) => ChatEntry,
): ChatEntry[] {
  if (entries.length === 0) return entries;
  const idx = entries.length - 1;
  if (entries[idx].role !== "assistant") return entries;
  const copy = [...entries];
  copy[idx] = fn(copy[idx]);
  return copy;
}

export const useChatStore = create<ChatState>((set, get) => ({
  entries: [],
  running: false,
  iteration: 0,
  iterationTextStart: 0,
  pendingApprovals: [],
  providers: [],
  providerId: "",
  model: "",
  autoApprove: false,
  pinnedPaths: [],
  input: "",
  loaded: false,

  init: async () => {
    if (get().loaded) return;
    try {
      const { providers } = await api.getProviders();
      const first = providers[0];
      set({
        providers,
        providerId: first?.id ?? "",
        model: first?.models[0] ?? "",
        loaded: true,
      });
    } catch (err) {
      console.error("provider load failed:", err);
      set({ loaded: true });
    }
  },

  setInput: (v) => set({ input: v }),
  setProvider: (id) => {
    const p = get().providers.find((x) => x.id === id);
    set({ providerId: id, model: p?.models[0] ?? "" });
  },
  setModel: (m) => set({ model: m }),
  toggleAutoApprove: () => set((s) => ({ autoApprove: !s.autoApprove })),

  togglePin: (path) =>
    set((s) => ({
      pinnedPaths: s.pinnedPaths.includes(path)
        ? s.pinnedPaths.filter((p) => p !== path)
        : [...s.pinnedPaths, path],
    })),

  send: (text, attachments) => {
    const { providerId, model, autoApprove } = get();
    if (!text.trim() || !model) return;
    set((s) => ({
      entries: [...s.entries,
        { role: "user", text, steps: [] } as ChatEntry,
        { role: "assistant", text: "", steps: [], streaming: true } as ChatEntry],
      running: true,
      iteration: 0,
      input: "",
    }));
    harnessSocket.send({ type: "chat.user", text, providerId, model, attachments, autoApprove });
  },

  cancel: () => harnessSocket.send({ type: "chat.cancel" }),

  resolveApproval: (id, approved) => {
    harnessSocket.send({ type: "chat.approve", id, approved });
    set((s) => ({
      pendingApprovals: s.pendingApprovals.map((a) =>
        a.id === id ? { ...a, resolved: approved ? ("approved" as const) : ("denied" as const) } : a,
      ),
    }));
  },

  handleEvent: (event) => {
    switch (event.type) {
      case "agent.started":
        set({ iteration: 0 });
        break;
      case "agent.iteration":
        set((s) => {
          const last = s.entries[s.entries.length - 1];
          return {
            iteration: event.iteration,
            iterationTextStart: last?.role === "assistant" ? last.text.length : 0,
          };
        });
        break;
      case "message.delta":
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({ ...e, text: e.text + event.text })),
        }));
        break;
      case "message.done":
        // The server may clean the streamed text (e.g. strip text-mode tool-call
        // syntax). Replace only THIS iteration's portion of the message so text
        // from earlier iterations is preserved.
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            text:
              event.text !== ""
                ? e.text.slice(0, s.iterationTextStart) + event.text
                : e.text,
            streaming: false,
          })),
        }));
        break;
      case "tool.started":
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            steps: [...e.steps, { id: event.id, tool: event.tool, args: event.args, status: "running" }],
          })),
        }));
        break;
      case "tool.finished":
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            steps: e.steps.map((st) =>
              st.id === event.id ? { ...st, status: event.ok ? ("ok" as const) : ("error" as const), result: event.result } : st,
            ),
          })),
        }));
        break;
      case "approval.required":
        set((s) => ({ pendingApprovals: [...s.pendingApprovals, { ...event.approval }] }));
        break;
      case "approval.resolved":
        // keep card visible with resolved badge; nothing to do
        break;
      case "agent.finished":
        set((s) => ({
          running: false,
          entries: updateLastAssistant(s.entries, (e) => ({ ...e, streaming: false })),
        }));
        break;
      case "agent.error":
        set((s) => ({
          running: false,
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            streaming: false,
            error: event.error,
          })),
        }));
        break;
      default:
        break;
    }
  },
}));
