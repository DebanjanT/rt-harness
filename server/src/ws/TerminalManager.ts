import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import type WebSocket from "ws";
import type { IPty } from "node-pty";
import { getConfig } from "../config.js";

const require = createRequire(import.meta.url);

/**
 * Real interactive shell over the WebSocket using node-pty (pseudo-terminal).
 * This gives full TTY behavior inside xterm.js: prompt, echo, colors, ctrl-C,
 * history, resize — everything a normal terminal does.
 *
 * Note: the npm-extracted `spawn-helper` binary can lose its +x bit, which
 * surfaces as "posix_spawnp failed". We self-heal by chmod-ing it on load.
 */
function ensurePtySpawnHelper(): void {
  if (os.platform() !== "darwin") return;
  try {
    const helperPath = path.join(
      path.dirname(require.resolve("node-pty/package.json")),
      "prebuilds",
      `darwin-${os.arch()}`,
      "spawn-helper",
    );
    if (fsSync.existsSync(helperPath)) {
      const stat = fsSync.statSync(helperPath);
      if (!(stat.mode & 0o111)) {
        fsSync.chmodSync(helperPath, 0o755);
        console.log("[terminal] fixed exec bit on node-pty spawn-helper");
      }
    }
  } catch {
    /* best effort — prebuild layout may differ in other versions */
  }
}
ensurePtySpawnHelper();

function loadPty(): typeof import("node-pty") {
  return require("node-pty") as typeof import("node-pty");
}

export class TerminalManager {
  private pty: IPty | null = null;
  private started = false;
  private dataDisposable: { dispose: () => void } | null = null;
  private exitDisposable: { dispose: () => void } | null = null;

  constructor(private ws: WebSocket) {}

  send(data: string) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: "terminal.output", data }));
    }
  }

  start() {
    if (this.started) return;
    this.started = true;

    const cwd = getConfig().workspaceRoot;
    const isWin = os.platform() === "win32";
    const shell = isWin ? "powershell.exe" : process.env.SHELL || "/bin/zsh";

    try {
      const pty = loadPty();
      this.pty = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        } as Record<string, string>,
      });

      this.dataDisposable = this.pty.onData((data) => this.send(data));
      this.exitDisposable = this.pty.onExit(({ exitCode }) => {
        this.send(`\r\n\x1b[90m[shell exited with code ${exitCode}]\x1b[0m\r\n`);
        this.pty = null;
        this.started = false;
      });

      this.send(`\x1b[90m-- rt-harness terminal (${shell}) --\x1b[0m\r\n`);
      console.log(`[terminal] PTY started: ${shell} @ ${cwd}`);
    } catch (err) {
      console.error("[terminal] failed to start PTY:", err);
      this.send(
        `\r\n\x1b[31mFailed to start shell: ${(err as Error).message}\x1b[0m\r\n` +
          `\x1b[90mTip: run 'chmod +x server/node_modules/node-pty/prebuilds/*/spawn-helper'\x1b[0m\r\n`,
      );
      this.started = false;
    }
  }

  input(data: string) {
    if (!this.started) this.start();
    this.pty?.write(data);
  }

  resize(cols: number, rows: number) {
    try {
      this.pty?.resize(Math.max(2, Math.min(cols, 500)), Math.max(2, Math.min(rows, 300)));
    } catch {
      /* pty may already be dead */
    }
  }

  dispose() {
    this.dataDisposable?.dispose();
    this.exitDisposable?.dispose();
    try {
      this.pty?.kill();
    } catch {
      /* already dead */
    }
    this.pty = null;
  }
}
