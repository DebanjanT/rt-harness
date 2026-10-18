import { create } from "zustand";
import type {
  AgentEvent,
  AgentMode,
  ApprovalRequest,
  ImageAttachment,
  ModelCapabilities,
  ProviderInfo,
  ToolPermission,
} from "../types/agent";
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
  /** Images attached to a user message. */
  images?: ImageAttachment[];
  /** Mode the message was sent in (shown as a small badge). */
  mode?: AgentMode;
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
  mode: AgentMode;
  autoApprove: boolean;
  /** Per-tool permission overrides ("auto" | "approval" | "disabled"). */
  toolPermissions: Record<string, ToolPermission>;
  /** @-mentioned / pinned workspace files (paths). */
  pinnedPaths: string[];
  /** Images attached in the composer awaiting send. */
  images: ImageAttachment[];
  /** Capability probe result for the current provider+model (null = probing/unknown). */
  capabilities: ModelCapabilities | null;
  capabilitiesLoading: boolean;
  input: string;
  loaded: boolean;

  init: () => Promise<void>;
  setInput: (v: string) => void;
  setProvider: (id: string) => void;
  setModel: (m: string) => void;
  setMode: (m: AgentMode) => void;
  toggleAutoApprove: () => void;
  setToolPermission: (tool: string, perm: ToolPermission) => void;
  togglePin: (path: string) => void;
  addImages: (files: FileList | File[]) => Promise<void>;
  removeImage: (index: number) => void;
  addProvider: (name: string, baseURL: string, apiKey: string) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  resolveApproval: (id: string, approved: boolean) => void;
  handleEvent: (event: AgentEvent) => void;
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
  mode: "agent",
  autoApprove: false,
  toolPermissions: {},
  pinnedPaths: [],
  images: [],
  capabilities: null,
  capabilitiesLoading: false,
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
    set({ providerId: id, model: p?.models[0] ?? "", capabilities: null });
  },

  setModel: (m) => set({ model: m, capabilities: null }),

  setMode: (m) => set({ mode: m }),

  toggleAutoApprove: () => set((s) => ({ autoApprove: !s.autoApprove })),

  setToolPermission: (tool, perm) =>
    set((s) => ({ toolPermissions: { ...s.toolPermissions, [tool]: perm } })),

  togglePin: (path) =>
    set((s) => ({
      pinnedPaths: s.pinnedPaths.includes(path)
        ? s.pinnedPaths.filter((p) => p !== path)
        : [...s.pinnedPaths, path],
    })),

  addImages: async (files) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const converted: ImageAttachment[] = [];
    for (const f of list) {
      try {
        converted.push({ name: f.name, dataUrl: await fileToDataUrl(f) });
      } catch (err) {
        console.error("image read failed:", err);
      }
    }
    set((s) => ({ images: [...s.images, ...converted] }));
  },

  removeImage: (index) =>
    set((s) => ({ images: s.images.filter((_, i) => i !== index) })),

  addProvider: async (name, baseURL, apiKey) => {
    await api.addProvider(name, baseURL, apiKey);
    const { providers } = await api.getProviders();
    const added = providers[providers.length - 1];
    set({
      providers,
      providerId: added?.id ?? get().providerId,
      model: added?.models[0] ?? "",
      capabilities: null,
    });
  },

  removeProvider: async (id) => {
    await api.removeProvider(id);
    const { providers } = await api.getProviders();
    const first = providers[0];
    set({
      providers,
      ...(get().providerId === id
        ? { providerId: first?.id ?? "", model: first?.models[0] ?? "", capabilities: null }
        : {}),
    });
  },

  send: async (text) => {
    const { providerId, model, autoApprove, mode, toolPermissions, pinnedPaths, images } = get();
    if ((!text.trim() && images.length === 0) || !model) return;

    // Fetch @-mentioned file contents before sending.
    const attachments: { path: string; content: string }[] = [];
    for (const p of pinnedPaths) {
      try {
        const f = await api.getFile(p);
        attachments.push({ path: f.path, content: f.content });
      } catch {
        /* file gone — skip */
      }
    }

    set((s) => ({
      entries: [...s.entries,
        { role: "user", text, steps: [], images: images.length ? [...images] : undefined, mode } as ChatEntry,
        { role: "assistant", text: "", steps: [], streaming: true } as ChatEntry],
      running: true,
      iteration: 0,
      input: "",
      // Clear the composer context after send: images AND @-file references
      // (their contents are already captured in the outgoing message).
      images: [],
      pinnedPaths: [],
    }));
    harnessSocket.send({
      type: "chat.user",
      text,
      providerId,
      model,
      mode,
      toolPermissions,
      images,
      attachments,
      autoApprove,
    });
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
