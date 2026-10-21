import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../config.js";
import { resolveInWorkspace, isBinaryPath, looksBinary } from "../security/PathPolicy.js";
import { pathExists, normalizeWorkspaceRelPath } from "../workspace/FileSystem.js";
import type { Tool } from "./ToolRegistry.js";
import { describeArgs } from "./ToolRegistry.js";

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Returns the full file content with line numbers. Refuses binary files.",
  permission: "auto",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path, e.g. src/App.tsx" },
      start_line: { type: "number", description: "Optional 1-based start line (for big files)" },
      end_line: { type: "number", description: "Optional 1-based end line" },
    },
    required: ["path"],
  },
  async execute(args) {
    const rel = normalizeWorkspaceRelPath(args.path);
    if (!rel) {
      return `Error: invalid or missing "path". Use a workspace-RELATIVE file path like "src/App.tsx". Received: ${describeArgs(args)}`;
    }
    const abs = resolveInWorkspace(rel);
    if (isBinaryPath(rel)) return `Error: "${rel}" looks like a binary file.`;
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      return `Error reading ${rel}: ${(err as Error).message}`;
    }
    if (looksBinary(Buffer.from(content.slice(0, 8000), "utf8"))) {
      return `Error: "${rel}" appears to be binary.`;
    }
    const maxChars = getConfig().agent.maxFileReadChars;
    const allLines = content.split("\n");
    const start = Math.max(1, Number(args.start_line ?? 1));
    const end = Math.min(allLines.length, Number(args.end_line ?? allLines.length));
    const selected = allLines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(5)} | ${line}`)
      .join("\n");
    let out = `File: ${rel} (${allLines.length} lines)\n\n${selected}`;
    if (out.length > maxChars) out = trunc(out, maxChars);
    return out;
  },
};

/** Naive line-based unified diff between original and new content. */
export function makeDiff(relPath: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  // Simple LCS-free diff: show changed/added/removed hunks via common prefix/suffix.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let sufA = a.length, sufB = b.length;
  while (sufA > pre && sufB > pre && a[sufA - 1] === b[sufB - 1]) { sufA--; sufB--; }
  const ctx = (i: number) => a[i] ?? b[i];
  const hunkStart = Math.max(0, pre - 3);
  const hunkEndA = Math.min(a.length, sufA + 3);
  const hunkEndB = Math.min(b.length, sufB + 3);
  lines.push(`@@ -${hunkStart + 1},${hunkEndA - hunkStart} +${hunkStart + 1},${hunkEndB - hunkStart} @@`);
  for (let i = hunkStart; i < pre; i++) lines.push(`  ${ctx(i)}`);
  for (let i = pre; i < sufA; i++) lines.push(`- ${a[i]}`);
  for (let i = pre; i < sufB; i++) lines.push(`+ ${b[i]}`);
  for (let i = sufA; i < hunkEndA; i++) lines.push(`  ${ctx(i)}`);
  return lines.join("\n");
}

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create or fully overwrite a file with new content. Requires user approval. Prefer edit_file for small changes.",
  permission: "approval",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: { type: "string", description: "The complete new file content" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const rel = normalizeWorkspaceRelPath(args.path);
    const content = String(args.content ?? "");

    // Arg validation — small local models sometimes omit or mangle the path.
    if (!rel || rel === ".") {
      return `Error: invalid or missing "path". Provide a workspace-RELATIVE file path, e.g. "sample.txt" or "src/App.tsx". Received: ${describeArgs(args)}`;
    }
    if (!args.content || typeof args.content !== "string") {
      return 'Error: invalid or missing "content". Pass the complete file content as a string.';
    }

    const abs = resolveInWorkspace(rel);
    if (abs === path.resolve(getConfig().workspaceRoot)) {
      return `Error: "${rel}" resolves to the workspace root, which is a directory. Use a file path like "sample.txt".`;
    }
    if (isBinaryPath(rel)) return `Error: refusing to write binary-looking path "${rel}".`;

    let before = "";
    if (await pathExists(abs)) before = await fs.readFile(abs, "utf8").catch(() => "");
    const diff = makeDiff(rel, before, content);

    const approved = ctx.autoApprove || (await ctx.requestApproval({
      kind: "file_write",
      tool: "write_file",
      summary: `Write ${rel} (${content.split("\n").length} lines)`,
      data: { path: rel, content },
      diff,
    }));
    if (!approved) return "User declined this file write.";

    await fs.mkdir(abs.slice(0, abs.lastIndexOf(path.sep || "/")), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    ctx.onFileChanged?.(rel);
    return `Wrote ${rel} (${content.length} chars).`;
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact substring in an existing file. The old_text must match the file exactly (including whitespace). Requires user approval; a diff is shown.",
  permission: "approval",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      old_text: { type: "string", description: "Exact text to find (must be unique)" },
      new_text: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_text", "new_text"],
  },
  async execute(args, ctx) {
    const rel = normalizeWorkspaceRelPath(args.path);
    const oldText = String(args.old_text ?? "");
    const newText = String(args.new_text ?? "");
    if (!rel || rel === ".") {
      return `Error: invalid or missing "path". Provide a workspace-RELATIVE file path, e.g. "src/App.tsx". Received: ${describeArgs(args)}`;
    }
    if (!oldText) {
      return 'Error: invalid or missing "old_text". Pass the exact existing text to replace.';
    }
    const abs = resolveInWorkspace(rel);
    if (!(await pathExists(abs))) return `Error: ${rel} does not exist. Use write_file to create it.`;
    const before = await fs.readFile(abs, "utf8");
    const count = before.split(oldText).length - 1;
    if (count === 0) return `Error: old_text not found in ${rel}. Re-read the file and retry with exact text.`;
    if (count > 1) return `Error: old_text appears ${count} times in ${rel}. Include more surrounding context to make it unique.`;
    const after = before.replace(oldText, newText);
    const diff = makeDiff(rel, before, after);

    const approved = ctx.autoApprove || (await ctx.requestApproval({
      kind: "file_write",
      tool: "edit_file",
      summary: `Edit ${rel}`,
      data: { path: rel, before, after },
      diff,
    }));
    if (!approved) return "User declined this edit.";

    await fs.writeFile(abs, after, "utf8");
    ctx.onFileChanged?.(rel);
    return `Edited ${rel}.`;
  },
};

export const listDirectoryTool: Tool = {
  name: "list_directory",
  description: "List the immediate children of a workspace directory.",
  permission: "auto",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory path ('' for root)" },
    },
    required: [],
  },
  async execute(args) {
    const rel = String(args.path ?? "");
    const abs = resolveInWorkspace(rel || "");
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
        .join("\n") || "(empty directory)";
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search file contents for a text or regex pattern. Returns matching file:line snippets. Respects a max result cap. Skips node_modules/.git/dist etc.",
  permission: "auto",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text or regex pattern to find" },
      is_regex: { type: "boolean", description: "Treat query as a regular expression" },
      include: { type: "string", description: "Optional glob-ish extension filter, e.g. '.ts'" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query ?? "");
    if (!query) return "Error: empty query.";
    const isRegex = Boolean(args.is_regex);
    const include = args.include ? String(args.include) : undefined;
    let regex: RegExp;
    try {
      regex = new RegExp(isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (err) {
      return `Error: invalid regex — ${(err as Error).message}`;
    }

    const maxResults = getConfig().agent.maxSearchResults;
    const results: string[] = [];
    const skip = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "target"]);

    const walk = async (dir: string, rel: string): Promise<void> => {
      if (results.length >= maxResults) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
        const childAbs = `${dir}/${entry.name}`;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(childAbs, childRel);
        } else if (entry.isFile() && !isBinaryPath(entry.name)) {
          if (include && !entry.name.includes(include.replace(/\*/g, ""))) continue;
          let content: string;
          try {
            content = await fs.readFile(childAbs, "utf8");
          } catch {
            continue;
          }
          if (looksBinary(Buffer.from(content.slice(0, 8000), "utf8"))) continue;
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${childRel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (results.length >= maxResults) return;
            }
          }
        }
      }
    };

    const root = resolveInWorkspace("");
    await walk(root, "");
    if (results.length === 0) return `No matches for "${query}".`;
    return `Found ${results.length} match(es):\n${results.join("\n")}`;
  },
};
