import { spawn } from "node:child_process";
import { getConfig } from "../config.js";
import { checkCommand } from "../security/CommandPolicy.js";
import { getCommandShell } from "../shell.js";
import type { Tool } from "./ToolRegistry.js";

const BLOCKED_MSG =
  "BLOCKED by security policy: this command is on the hard blocklist (destructive to system, piped-to-shell downloads, force pushes, etc.). It will never be executed.";

export const executeCommandTool: Tool = {
  name: "execute_command",
  description: `Execute a shell command in the workspace root (${getCommandShell().name} — write the command in that syntax). Output (stdout+stderr) is returned, capped. Destructive system commands are hard-blocked; everything else requires user approval unless auto-approve is on.`,
  permission: "approval",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
      timeout_ms: { type: "number", description: "Optional timeout in ms (default 120000, max 600000)" },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    const command = String(args.command ?? "").trim();
    if (!command) return "Error: empty command.";

    const verdict = checkCommand(command);
    if (verdict === "hard_block") return BLOCKED_MSG;

    const approved =
      ctx.autoApprove ||
      verdict === "auto_ok" ||
      (await ctx.requestApproval({
        kind: "command",
        tool: "execute_command",
        summary: command,
        data: { command },
      }));
    if (!approved) return "User declined to run this command.";

    return runCommand(command, Number(args.timeout_ms ?? 120_000), ctx.signal);
  },
};

export function runCommand(command: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const maxOutput = 20000;
  const timeout = Math.min(Math.max(timeoutMs, 1000), 600_000);
  const sh = getCommandShell();

  return new Promise((resolve) => {
    const child = spawn(sh.shell, [...sh.args, command], {
      cwd: getConfig().workspaceRoot,
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      signal,
    });

    let out = "";
    const collect = (chunk: Buffer | string) => {
      out += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);

    const finish = (code: number | null, killed: boolean) => {
      clearTimeout(timer);
      let text = out;
      if (text.length > maxOutput) {
        text = text.slice(0, maxOutput) + `\n… [output truncated, ${text.length - maxOutput} chars dropped]`;
      }
      const status = killed ? "timed out" : `exit code ${code ?? "unknown"}`;
      resolve(text.trim() ? `$ ${command}\n${text}\n(${status})` : `$ ${command}\n(no output) (${status})`);
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error spawning command: ${err.message}`);
    });
    child.on("close", (code, signalReceived) => finish(code, signalReceived === "SIGKILL"));
  });
}

export const gitTools: Tool[] = [
  {
    name: "git_status",
    description: "Show git status of the workspace (read-only).",
    permission: "auto",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_args, ctx) {
      return runCommand("git status --short --branch", 15_000, ctx.signal);
    },
  },
  {
    name: "git_diff",
    description: "Show the current unstaged+staged diff (read-only). Pass a path to narrow it.",
    permission: "auto",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Optional file path filter" } },
      required: [],
    },
    async execute(args, ctx) {
      const p = args.path ? ` -- ${String(args.path)}` : "";
      return runCommand(`git diff HEAD${p}`, 20_000, ctx.signal);
    },
  },
  {
    name: "git_log",
    description: "Show recent commit history (read-only).",
    permission: "auto",
    parameters: {
      type: "object",
      properties: { count: { type: "number", description: "Number of commits (default 10)" } },
      required: [],
    },
    async execute(args, ctx) {
      const n = Math.min(Number(args.count ?? 10), 50);
      return runCommand(`git log --oneline -n ${n}`, 15_000, ctx.signal);
    },
  },
];
