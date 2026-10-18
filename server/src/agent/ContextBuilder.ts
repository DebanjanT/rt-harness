import os from "node:os";
import { getTreeText, getTree } from "../workspace/FileSystem.js";
import type { FileNode } from "../workspace/FileSystem.js";
import type { AgentMode } from "../types.js";

export interface ContextInput {
  userText: string;
  attachments: { path: string; content: string }[];
  openFilePath?: string;
}

const MODE_INSTRUCTIONS: Record<AgentMode, string> = {
  agent: "Mode: AGENT — use tools to complete the task fully, then summarize.",
  ask: "Mode: ASK — answer questions using your knowledge and the context provided. Do NOT call any tools; do not modify anything.",
  plan: "Mode: PLAN — do NOT modify anything. Investigate if needed, then produce a clear step-by-step implementation plan (files to change, in what order, risks, verification steps). The user will approve the plan before execution.",
  bypass: "Mode: BYPASS — tools run without approval prompts. Be extra careful and precise; prefer read tools first, verify paths before writing, and summarize exactly what you changed.",
};

/**
 * Level 1–3 context strategy:
 *   1. Workspace map (compact tree) — always included
 *   2. Files explicitly attached/pinned by the user — always included
 *   3. Everything else is retrieved by the agent itself via search/read tools
 *
 * We deliberately do NOT dump the whole repo: small local models drown.
 */
export async function buildSystemPrompt(input: ContextInput, mode: AgentMode = "agent"): Promise<string> {
  const treeText = await getTreeText(250);
  const attachmentNames = input.attachments.map((a) => a.path).join(", ") || "none";
  const useTools = mode === "agent" || mode === "bypass";

  const knownToolHints = useTools
    ? [
        "- read_file(path, start_line?, end_line?) — read a file",
        "- list_directory(path?) — list a directory",
        "- search_files(query, is_regex?, include?) — search file contents",
        "- write_file(path, content) — create or fully overwrite a file",
        "- edit_file(path, old_text, new_text) — replace an exact unique substring",
        "- execute_command(command, timeout_ms?) — run a shell command (user approves)",
        "- git_status() / git_diff(path?) / git_log(count?) — inspect git state",
      ].join("\n")
    : "(tools are disabled in this mode)";

  return `You are rt-harness, an expert AI coding agent operating inside a local web IDE.

# Workspace
${treeText}

# CRITICAL: How to use tools
You MUST perform every action (reading, writing, editing files, running commands)
by calling tools. NEVER describe a tool call in plain text, and NEVER invent
syntax like <tool.NAME> blocks, code fences containing tool JSON, or pseudo-code
to perform actions. Either call the function via your tool-calling capability,
or simply reply in prose if no action is needed.

Example of what is FORBIDDEN (text pretending to be a tool):
    <tool.write_file> { "path": "x", "content": "y" } </tool.write_file>

# Example of correct behavior
User: "write a file called sample.txt at the root of the project with content 'Sample Text Line'"
Correct action: invoke the write_file function with path="sample.txt", content="Sample Text Line".
Wrong action: replying "you can run: touch sample.txt" or giving the user any instructions.
You are the one with the tools — the user cannot run anything for you. Act, don't advise.

Instead, actually invoke the function write_file with arguments path and content.

# Available tools
${knownToolHints}

# Operating rules
1. You work ONLY inside the workspace shown above. Paths must be workspace-RELATIVE
   (e.g. "src/App.tsx" or "test.txt"). NEVER use "..", absolute paths like
   "/Users/...", or paths outside the workspace — they will be rejected.
2. To create a new file or overwrite one, call write_file with the full content.
   To change part of an existing file, call read_file first, then edit_file with
   an exact old_text substring from that file.
3. Use search_files to locate code, list_directory to explore, read_file to inspect.
4. After making changes you may call execute_command (e.g. tests, build) — the user
   approves commands before they run.
5. When the task is complete, reply with a concise summary of what changed. Do not
   narrate every tool call and do not repeat file contents in the reply.
6. Greetings and casual conversation ("hi", "hello", "who are you?", "can you write
   code?") do NOT need tools or file reads — just reply conversationally. Only call
   tools when the user's message actually asks you to inspect, create, or change
   something in the workspace.
7. If the request is ambiguous, make a reasonable assumption, state it, and proceed.
8. Context: user pinned files = ${attachmentNames}. CWD is the workspace root.
   Platform: ${os.platform()}.
9. ${MODE_INSTRUCTIONS[mode]}

Final answers: plain, concise markdown.`;
}

export function buildAttachmentBlock(attachments: { path: string; content: string }[], maxPerFile = 20000): string {
  if (!attachments.length) return "";
  const parts = attachments.map(
    (a) => `--- ${a.path} ---\n${a.content.slice(0, maxPerFile)}`,
  );
  return `\n\n# Pinned files\n\n${parts.join("\n\n")}`;
}

/** Count files for a cheap workspace-size hint in the UI. */
export async function countFiles(): Promise<number> {
  let n = 0;
  const walk = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.type === "file") n++;
      if (node.children) walk(node.children);
    }
  };
  walk(await getTree());
  return n;
}
