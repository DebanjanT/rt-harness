import fs from "node:fs/promises";
import { resolveInWorkspace } from "../workspace/FileSystem.js";

/**
 * Per-session run state that must outlive a single agent run:
 *  - TodoStore: the model's task list (todo_write tool)
 *  - ChangeStore: every file mutation the agent made this session, with
 *    before/after snapshots so the UI can show diffs and undo changes.
 */

/* ------------------------------ Todos ------------------------------------- */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

let todos: TodoItem[] = [];

export const TodoStore = {
  get(): TodoItem[] {
    return todos;
  },
  set(next: TodoItem[]): TodoItem[] {
    todos = next.slice(0, 50);
    return todos;
  },
  clear(): void {
    todos = [];
  },
  /** Progress summary like "3/5". */
  progress(): { done: number; total: number } {
    return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
  },
};

/* --------------------------- File changes --------------------------------- */

export interface FileChange {
  id: string;
  /** Workspace-relative path (for renames: the NEW path). */
  path: string;
  /** For renames: the original path. */
  fromPath?: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  before: string | null;
  after: string | null;
  added: number;
  removed: number;
  at: number;
}

export interface FileChangeSummary {
  id: string;
  path: string;
  fromPath?: string;
  kind: FileChange["kind"];
  added: number;
  removed: number;
}

const MAX_CHANGES = 200;
const MAX_SNAPSHOT_CHARS = 200_000; // per before/after snapshot
const MAX_DIFF_LINES = 5000;

let changes: FileChange[] = [];

/** Simple LCS line diff — counts added/removed lines. */
export function diffStats(before: string | null, after: string | null): { added: number; removed: number } {
  const a = before === null ? [] : before.split("\n").slice(0, MAX_DIFF_LINES);
  const b = after === null ? [] : after.split("\n").slice(0, MAX_DIFF_LINES);
  // Guard: LCS is O(n·m) — cap total cells to keep big rewrites fast.
  if (a.length * b.length > 4_000_000) {
    const aSet = new Set(a);
    const bSet = new Set(b);
    return {
      added: b.filter((l) => !aSet.has(l)).length,
      removed: a.filter((l) => !bSet.has(l)).length,
    };
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:] — use rolling rows to save memory.
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      curr[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[0];
  return { added: m - lcs, removed: n - lcs };
}

function summarize(c: FileChange): FileChangeSummary {
  return { id: c.id, path: c.path, fromPath: c.fromPath, kind: c.kind, added: c.added, removed: c.removed };
}

function clip(s: string | null): string | null {
  if (s === null) return null;
  return s.length > MAX_SNAPSHOT_CHARS ? s.slice(0, MAX_SNAPSHOT_CHARS) : s;
}

/** Record one file mutation (dedupes consecutive identical content no-ops). */
export function recordFileChange(input: {
  path: string;
  fromPath?: string;
  kind: FileChange["kind"];
  before: string | null;
  after: string | null;
}): FileChange | null {
  const { added, removed } = diffStats(input.before, input.after);
  if (input.kind !== "renamed" && added === 0 && removed === 0) return null; // no-op write
  const change: FileChange = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    path: input.path,
    fromPath: input.fromPath,
    kind: input.kind,
    before: clip(input.before),
    after: clip(input.after),
    added,
    removed,
    at: Date.now(),
  };
  changes.push(change);
  if (changes.length > MAX_CHANGES) changes = changes.slice(-MAX_CHANGES);
  return change;
}

export const ChangeStore = {
  list(): FileChangeSummary[] {
    // Collapse: keep only the LATEST change per path so the UI shows the net
    // effect per file (like VS Code's timeline of pending edits).
    const byPath = new Map<string, FileChangeSummary>();
    for (const c of changes) byPath.set(c.path, summarize(c));
    return [...byPath.values()];
  },
  get(id: string): FileChange | undefined {
    return changes.find((c) => c.id === id);
  },
  /** Latest change record for a path (used for diffs). */
  latestForPath(path: string): FileChange | undefined {
    for (let i = changes.length - 1; i >= 0; i--) if (changes[i].path === path) return changes[i];
    return undefined;
  },
  clear(): void {
    changes = [];
  },
  /**
   * Undo all recorded changes (newest first) and clear the store.
   * Returns the list of paths touched.
   */
  async undoAll(): Promise<string[]> {
    const touched = new Set<string>();
    // Restore in REVERSE order so older snapshots win for repeated edits.
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      try {
        if (c.fromPath) {
          // rename: move back if target still exists
          await fs.rename(resolveInWorkspace(c.path), resolveInWorkspace(c.fromPath)).catch(() => {});
          touched.add(c.fromPath);
          continue;
        }
        if (c.before === null) {
          // created → delete it again
          await fs.rm(resolveInWorkspace(c.path), { recursive: true, force: true });
        } else {
          // modified/deleted → restore original content (and parent dirs)
          const abs = resolveInWorkspace(c.path);
          await fs.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
          await fs.writeFile(abs, c.before, "utf8");
        }
        touched.add(c.path);
      } catch (err) {
        console.warn(`[changes] undo failed for ${c.path}:`, (err as Error).message);
      }
    }
    changes = [];
    return [...touched];
  },
};

/** Read a workspace file if it exists; null otherwise. */
export async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
}
