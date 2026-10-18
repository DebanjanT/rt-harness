import { create } from "zustand";
import { api } from "../lib/api";

export interface EditorTab {
  path: string;
  content: string;
  dirty: boolean;
  language: string;
}

function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", css: "css", scss: "scss", html: "html", md: "markdown",
    py: "python", rs: "rust", go: "go", sh: "shell", yml: "yaml", yaml: "yaml",
    sql: "sql", c: "c", cpp: "cpp", h: "cpp", java: "java", rb: "ruby",
    php: "php", swift: "swift", kt: "kotlin", toml: "ini", env: "ini",
  };
  return map[ext] ?? "plaintext";
}

interface EditorState {
  tabs: EditorTab[];
  activePath: string | null;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveTab: (path: string) => Promise<void>;
  reloadIfOpen: (path: string) => Promise<void>;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activePath: null,

  openFile: async (path: string) => {
    const existing = get().tabs.find((t) => t.path === path);
    set({ activePath: path });
    if (existing) return;
    try {
      const { content } = await api.getFile(path);
      set((s) => ({
        tabs: [...s.tabs, { path, content, dirty: false, language: languageFor(path) }],
        activePath: path,
      }));
    } catch (err) {
      console.error("openFile failed:", err);
    }
  },

  closeTab: (path: string) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path);
      const activePath =
        s.activePath === path ? (tabs.length ? tabs[tabs.length - 1].path : null) : s.activePath;
      return { tabs, activePath };
    });
  },

  setActive: (path: string) => set({ activePath: path }),

  updateContent: (path: string, content: string) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, content, dirty: true } : t)),
    }));
  },

  saveTab: async (path: string) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    await api.saveFile(path, tab.content);
    set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)) }));
  },

  reloadIfOpen: async (path: string) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || tab.dirty) return; // don't clobber user edits
    try {
      const { content } = await api.getFile(path);
      set((s) => ({
        tabs: s.tabs.map((t) => (t.path === path ? { ...t, content, dirty: false } : t)),
      }));
    } catch {
      /* file may have been deleted */
    }
  },
}));
