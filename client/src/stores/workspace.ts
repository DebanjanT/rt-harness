import { create } from "zustand";
import type { FileNode } from "../types/agent";
import { api } from "../lib/api";

interface WorkspaceState {
  root: string;
  tree: FileNode[];
  expanded: Set<string>;
  loading: boolean;
  error: string | null;
  loadTree: () => Promise<void>;
  toggleExpand: (path: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: "",
  tree: [],
  expanded: new Set(),
  loading: false,
  error: null,

  loadTree: async () => {
    set({ loading: true, error: null });
    try {
      const { root, tree } = await api.getTree();
      // Keep previously expanded dirs that still exist.
      set({ root, tree, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  toggleExpand: (path: string) => {
    const expanded = new Set(get().expanded);
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    set({ expanded });
  },
}));
