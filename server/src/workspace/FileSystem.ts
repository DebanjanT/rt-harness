import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../config.js";

/** Resolve a workspace-relative path safely — rejects traversal outside root. */
export function resolveInWorkspace(relPath: string): string {
  const root = path.resolve(getConfig().workspaceRoot);
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace root: ${relPath}`);
  }
  return target;
}

/**
 * Best-effort normalization of an LLM-supplied path — small models often send
 * absolute paths ("E:\proj\src\App.tsx", "/src/App.tsx") or wrap them in
 * quotes/file://. Returns a clean workspace-relative path with forward
 * slashes; "" when nothing usable remains (the caller then rejects).
 */
export function normalizeWorkspaceRelPath(raw: unknown): string {
  let s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  s = s.replace(/^file:\/\//i, "").replace(/^["']|["']$/g, "").trim();
  const root = path.resolve(getConfig().workspaceRoot);
  if (/^[a-zA-Z]:[\\/]/.test(s)) {
    // Drive-letter absolute path: only usable if it lives INSIDE the workspace.
    const abs = path.resolve(s);
    if (abs === root || abs.startsWith(root + path.sep)) {
      s = path.relative(root, abs);
    } else {
      return ""; // genuinely outside the workspace — caller rejects with received args
    }
  } else if (s.startsWith("/") || s.startsWith("\\")) {
    const abs = path.resolve(s);
    if (abs === root || abs.startsWith(root + path.sep)) {
      s = path.relative(root, abs);
    } else {
      s = s.replace(/^[\\/]+/, ""); // "/src/x" style — almost always means workspace-relative
    }
  }
  return s
    .replace(/^[\\/]+/, "")
    .replace(/^(\.[\\/])+/, "") // leading "./"
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/");
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".venv",
  "venv", "__pycache__", ".cache", "target", ".DS_Store", "coverage",
]);

/** Build the full workspace tree (pruned of noise dirs). */
export async function getTree(relPath = "", depth = 0): Promise<FileNode[]> {
  if (depth > 12) return [];
  const abs = resolveInWorkspace(relPath || "");
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRel,
        type: "directory",
        children: await getTree(childRel, depth + 1),
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: childRel, type: "file" });
    }
  }
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
  );
  return nodes;
}

/** Compact indented tree string for the LLM system prompt. */
export async function getTreeText(maxLines = 300): Promise<string> {
  const lines: string[] = [];
  const walk = async (nodes: FileNode[], prefix: string) => {
    if (lines.length >= maxLines) return;
    for (const n of nodes) {
      if (lines.length >= maxLines) {
        lines.push(`${prefix}… (truncated)`);
        return;
      }
      lines.push(`${prefix}${n.name}${n.type === "directory" ? "/" : ""}`);
      if (n.children) await walk(n.children, `${prefix}  `);
    }
  };
  await walk(await getTree(), "");
  return lines.join("\n");
}
