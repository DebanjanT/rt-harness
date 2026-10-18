import { create } from "zustand";
import type {
  AgentEvent,
  AgentMode,
  ApprovalRequest,
  ImageAttachment,
  ModelCapabilities,
  ProviderInfo,
  ThinkingEffort,
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

export type PendingApproval = ApprovalRequest & {
  resolved?: "approved" | "denied";
};

/**
 * Ordered timeline of an assistant turn. This is what makes the conversation
 * read in true sequence: text → tool call → approval → more text.
 */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; step: ToolStep }
  | { kind: "approval"; approval: PendingApproval };

export interface ChatEntry {
  role: "user" | "assistant";
  segments: Segment[];
  streaming?: boolean;
  error?: string;
  /** Images attached to a user message. */
  images?: ImageAttachment[];
  /** Mode the message was sent in (shown as a small badge). */
  mode?: AgentMode;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requests: number;
  tokensPerSec: number;
  contextTokens: number;
  contextWindow: number | null;
}

interface ChatState {
  entries: ChatEntry[];
  running: boolean;
  iteration: number;
  /**
   * Where the current agent iteration's text begins in the last assistant
   * entry's timeline — used by message.done to swap raw streamed text (which
   * may include tool-call syntax) for the server-cleaned version.
   */
  iterSegIdx: number;
  iterCharStart: number;
  providers: ProviderInfo[];
  providerId: string;
  model: string;
  mode: AgentMode;
  autoApprove: boolean;
  /** Reasoning effort for thinking-capable models. */
  thinkingEffort: ThinkingEffort;
  /** Per-tool permission overrides ("auto" | "approval" | "disabled"). */
  toolPermissions: Record<string, ToolPermission>;
  /** @-mentioned / pinned workspace files (paths). */
  pinnedPaths: string[];
  /** Images attached in the composer awaiting send. */
  images: ImageAttachment[];
  /** Capability probe result for the current provider+model (null = probing/unknown). */
  capabilities: ModelCapabilities | null;
  capabilitiesLoading: boolean;
  /** Live token/request stats from the agent run (last usage event). */
  usage: UsageStats | null;
  input: string;
  loaded: boolean;

  init: () => Promise<void>;
  setInput: (v: string) => void;
  setProvider: (id: string) => void;
  setModel: (m: string) => void;
  setMode: (m: AgentMode) => void;
  setThinkingEffort: (e: ThinkingEffort) => void;
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

/* ---------- timeline helpers ---------- */

function appendText(segments: Segment[], t: string): Segment[] {
  if (!t) return segments;
  const last = segments[segments.length - 1];
  if (last && last.kind === "text") {
    return [...segments.slice(0, -1), { kind: "text", text: last.text + t }];
  }
  return [...segments, { kind: "text", text: t }];
}

function updateToolSegment(
  segments: Segment[],
  id: string,
  patch: Partial<ToolStep>,
): Segment[] {
  return segments.map((seg) =>
    seg.kind === "tool" && seg.step.id === id
      ? { ...seg, step: { ...seg.step, ...patch } }
      : seg,
  );
}

function updateApprovalSegment(
  segments: Segment[],
  id: string,
  resolved: "approved" | "denied",
): Segment[] {
  return segments.map((seg) =>
    seg.kind === "approval" && seg.approval.id === id
      ? { ...seg, approval: { ...seg.approval, resolved } }
      : seg,
  );
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
  iterSegIdx: 0,
  iterCharStart: 0,
  providers: [],
  providerId: "",
  model: "",
  mode: "agent",
  autoApprove: false,
  thinkingEffort: "off",
  toolPermissions: {},
  pinnedPaths: [],
  images: [],
  capabilities: null,
  capabilitiesLoading: false,
  usage: null,
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

  setThinkingEffort: (e) => set({ thinkingEffort: e }),

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
    const { providerId, model, autoApprove, mode, toolPermissions, pinnedPaths, images, thinkingEffort } = get();
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
        {
          role: "user",
          segments: text.trim() ? [{ kind: "text", text } as Segment] : [],
          images: images.length ? [...images] : undefined,
          mode,
        } as ChatEntry,
        { role: "assistant", segments: [], streaming: true } as ChatEntry],
      running: true,
      iteration: 0,
      iterSegIdx: 0,
      iterCharStart: 0,
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
      thinkingEffort,
      images,
      attachments,
      autoApprove,
    });
  },

  cancel: () => harnessSocket.send({ type: "chat.cancel" }),

  resolveApproval: (id, approved) => {
    harnessSocket.send({ type: "chat.approve", id, approved });
    // Optimistic UI update; the server echoes approval.resolved too.
    set((s) => ({
      entries: s.entries.map((en) =>
        en.role === "assistant"
          ? { ...en, segments: updateApprovalSegment(en.segments, id, approved ? "approved" : "denied") }
          : en,
      ),
    }));
  },

  handleEvent: (event) => {
    switch (event.type) {
      case "agent.started":
        set({ iteration: 0, usage: null });
        break;

      case "agent.iteration":
        set((s) => {
          const last = s.entries[s.entries.length - 1];
          let segIdx = 0;
          let charStart = 0;
          if (last?.role === "assistant") {
            const lastSeg = last.segments[last.segments.length - 1];
            if (lastSeg?.kind === "text") {
              segIdx = last.segments.length - 1;
              charStart = lastSeg.text.length;
            } else {
              segIdx = last.segments.length;
              charStart = 0;
            }
          }
          return { iteration: event.iteration, iterSegIdx: segIdx, iterCharStart: charStart };
        });
        break;

      case "message.delta":
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            segments: appendText(e.segments, event.text),
          })),
        }));
        break;

      case "thinking.delta":
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => {
            const segs = [...(Array.isArray(e.segments) ? e.segments : [])];
            const last = segs[segs.length - 1];
            if (last && last.kind === "thinking") {
              segs[segs.length - 1] = { kind: "thinking", text: last.text + event.text };
            } else {
              segs.push({ kind: "thinking", text: event.text });
            }
            return { ...e, segments: segs };
          }),
        }));
        break;

      case "message.done": {
        // The server may clean the streamed text (strip text-mode tool-call
        // syntax). Replace THIS iteration's raw text with the cleaned version
        // IN PLACE — the raw stream is the first text segment at/after
        // iterSegIdx; thinking/tool segments around it keep their positions.
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => {
            if (event.text === "") return e;
            const segs = [...(Array.isArray(e.segments) ? e.segments : [])];
            const startIdx = Math.min(s.iterSegIdx, segs.length);
            const segAt = segs[startIdx];

            if (segAt?.kind === "text") {
              // The iteration's raw stream continued the segment that existed
              // at iteration start — replace its tail with the cleaned text.
              const prefix = segAt.text.slice(0, s.iterCharStart);
              segs[startIdx] = { kind: "text", text: prefix + event.text };
              return { ...e, segments: segs };
            }

            // Text started a fresh segment after thinking/tool segments. The
            // raw stream may span multiple text segments (thinking interleaved
            // mid-stream). If cleaning didn't change anything, keep the nice
            // interleaved layout as-is; otherwise place the cleaned text at
            // the FIRST text position, dropping the other raw text segments.
            const textIdxs: number[] = [];
            segs.forEach((seg, i) => {
              if (i >= startIdx && seg.kind === "text") textIdxs.push(i);
            });
            if (textIdxs.length > 0) {
              const combinedRaw = textIdxs.map((i) => (segs[i] as { text: string }).text).join("");
              if (combinedRaw === event.text) {
                return { ...e, segments: segs }; // nothing stripped — keep layout
              }
              const first = textIdxs[0]!;
              segs[first] = { kind: "text", text: event.text };
              for (let k = textIdxs.length - 1; k >= 1; k--) segs.splice(textIdxs[k], 1);
              return { ...e, segments: segs };
            }
            // No raw text was streamed (e.g. placeholder case) — append.
            segs.push({ kind: "text", text: event.text });
            return { ...e, segments: segs };
          }),
        }));
        break;
      }

      case "tool.started":
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            segments: [...e.segments, {
              kind: "tool",
              step: { id: event.id, tool: event.tool, args: event.args, status: "running" },
            } as Segment],
          })),
        }));
        break;

      case "tool.finished":
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            segments: updateToolSegment(e.segments, event.id, {
              status: event.ok ? "ok" : "error",
              result: event.result,
            }),
          })),
        }));
        break;

      case "approval.required": {
        const approval: PendingApproval = { ...event.approval };
        set((s) => ({
          entries: updateLastAssistant(s.entries, (e) => ({
            ...e,
            segments: [...e.segments, { kind: "approval", approval } as Segment],
          })),
        }));
        break;
      }

      case "approval.resolved":
        set((s) => ({
          entries: s.entries.map((en) =>
            en.role === "assistant"
              ? { ...en, segments: updateApprovalSegment(en.segments, event.id, event.approved ? "approved" : "denied") }
              : en,
          ),
        }));
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
