import fsSync from "node:fs";
import path from "node:path";
import type { Tool } from "./ToolRegistry.js";
import { resolveInWorkspace, pathExists } from "../workspace/FileSystem.js";
import { getConfig } from "../config.js";
import { getTreeText } from "../workspace/FileSystem.js";

/**
 * Workspace-management tools (mkdir, delete, move, workspace info) —
 * the remaining items from the V1 tool checklist.
 */

export const mkdirTool: Tool = {
  name: "mkdir",
  description:
    "Create a directory (and any missing parents) in the workspace. Use before write_file if you need an empty folder structure.",
  permission: "auto",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory path to create" },
    },
    required: ["path"],
  },
  async execute(args) {
    const rel = String(args.path ?? "").trim();
    if (!rel || rel === "." || rel === "/") {
      return 'Error: provide a workspace-relative directory path, e.g. "src/components".';
    }
    try {
      const abs = resolveInWorkspace(rel);
      if (fsSync.existsSync(abs) && fsSync.statSync(abs).isDirectory()) {
        return `Directory already exists: ${rel}`;
      }
      await fsSync.promises.mkdir(abs, { recursive: true });
      return `Created directory ${rel}`;
    } catch (err) {
      return `Error creating directory: ${(err as Error).message}`;
    }
  },
};

export const deleteFileTool: Tool = {
  name: "delete_file",
  description:
    "Delete a file OR directory (recursive) from the workspace. Requires user approval — destructive.",
  permission: "approval",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to delete" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const rel = String(args.path ?? "").trim();
    if (!rel || rel === "." || rel === "/") {
      return "Error: refusing to delete the workspace root.";
    }
    const abs = resolveInWorkspace(rel);
    if (abs === path.resolve(getConfig().workspaceRoot)) {
      return "Error: cannot delete the workspace root.";
    }
    if (!(await pathExists(abs))) return `Error: ${rel} does not exist.`;

    const approved = ctx.autoApprove ||
      (await ctx.requestApproval({
        kind: "file_write",
        tool: "delete_file",
        summary: `Delete ${rel}${fsSync.statSync(abs).isDirectory() ? " (directory, recursive)" : ""}`,
        data: { path: rel },
      }));
    if (!approved) return "User declined this deletion.";

    await fsSync.promises.rm(abs, { recursive: true });
    ctx.onFileChanged?.(rel);
    return `Deleted ${rel}.`;
  },
};

export const moveFileTool: Tool = {
  name: "move_file",
  description:
    "Move or rename a file/directory within the workspace. Requires user approval.",
  permission: "approval",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Current workspace-relative path" },
      to: { type: "string", description: "New workspace-relative path" },
    },
    required: ["from", "to"],
  },
  async execute(args, ctx) {
    const from = String(args.from ?? "").trim();
    const to = String(args.to ?? "").trim();
    if (!from || !to) return "Error: both from and to paths are required.";
    const absFrom = resolveInWorkspace(from);
    const absTo = resolveInWorkspace(to);
    if (!(await pathExists(absFrom))) return `Error: source ${from} does not exist.`;
    if (await pathExists(absTo)) return `Error: destination ${to} already exists.`;

    const approved = ctx.autoApprove ||
      (await ctx.requestApproval({
        kind: "file_write",
        tool: "move_file",
        summary: `Move ${from} → ${to}`,
        data: { from, to },
      }));
    if (!approved) return "User declined this move.";

    await fsSync.promises.mkdir(path.dirname(absTo), { recursive: true });
    await fsSync.promises.rename(absFrom, absTo);
    ctx.onFileChanged?.(from);
    ctx.onFileChanged?.(to);
    return `Moved ${from} → ${to}.`;
  },
};

export const workspaceInfoTool: Tool = {
  name: "get_workspace_info",
  description:
    "Get the current workspace context: absolute root path, platform, working directory structure summary, and OS info. Call when you need orientation.",
  permission: "auto",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    const cfg = getConfig();
    const os = await import("node:os");
    const tree = await getTreeText(40);
    return [
      `Workspace root: ${cfg.workspaceRoot}`,
      `Platform: ${os.platform()} (${os.arch()})`,
      `Node: ${process.version}`,
      `Top-level structure:\n${tree}`,
    ].join("\n");
  },
};
