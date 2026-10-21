import fsSync from "node:fs";
import { execFileSync } from "node:child_process";

export type ShellKind = "bash" | "powershell" | "posix";

export interface ShellInfo {
  /** Executable to spawn. */
  shell: string;
  /** Extra args before the command (e.g. -c / -Command). */
  args: string[];
  kind: ShellKind;
  /** Human-readable name (also shown to the model in the system prompt). */
  name: string;
}

let cachedBash: string | null | undefined;

/**
 * Find a real bash.exe on Windows (Git Bash / MSYS2). System32's bash.exe
 * (WSL launcher) is deliberately excluded — its path semantics differ and it
 * may not be installed.
 */
export function findWindowsBash(): string | null {
  if (cachedBash !== undefined) return cachedBash;
  if (process.platform !== "win32") return (cachedBash = null);

  const pf = process.env.ProgramFiles ?? "";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "";
  const lad = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    pf ? `${pf}\\Git\\bin\\bash.exe` : "",
    pf86 ? `${pf86}\\Git\\bin\\bash.exe` : "",
    lad ? `${lad}\\Programs\\Git\\bin\\bash.exe` : "",
    "C:\\Git\\bin\\bash.exe",
    "C:\\MSYS64\\usr\\bin\\bash.exe",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (fsSync.existsSync(c)) return (cachedBash = c);
    } catch {
      /* ignore */
    }
  }

  // PATH lookup as a fallback — but never accept the WSL launcher in System32.
  try {
    const out = execFileSync("where.exe", ["bash"], { timeout: 3000 }).toString();
    const hit = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().endsWith("bash.exe") && !/\\windows\\/i.test(l));
    if (hit && fsSync.existsSync(hit)) return (cachedBash = hit);
  } catch {
    /* not on PATH */
  }
  return (cachedBash = null);
}

/**
 * Shell used for `execute_command` (one-shot commands). Prefers Git Bash on
 * Windows so POSIX commands (ls, rm -rf, mkdir -p, grep, |) actually work;
 * falls back to PowerShell otherwise.
 */
export function getCommandShell(): ShellInfo {
  if (process.platform === "win32") {
    const bash = findWindowsBash();
    if (bash) return { shell: bash, args: ["-c"], kind: "bash", name: "Git Bash (bash)" };
    return { shell: "powershell.exe", args: ["-Command"], kind: "powershell", name: "Windows PowerShell" };
  }
  return { shell: process.env.SHELL || "/bin/bash", args: ["-c"], kind: "posix", name: "bash" };
}

/**
 * Shell used for the interactive terminal pane. Same preference; bash gets a
 * login-interactive session so profiles and PATH load.
 */
export function getInteractiveShell(): ShellInfo {
  if (process.platform === "win32") {
    const bash = findWindowsBash();
    if (bash) return { shell: bash, args: ["--login", "-i"], kind: "bash", name: "Git Bash (bash)" };
    return { shell: "powershell.exe", args: [], kind: "powershell", name: "Windows PowerShell" };
  }
  return { shell: process.env.SHELL || "/bin/zsh", args: [], kind: "posix", name: "bash" };
}
