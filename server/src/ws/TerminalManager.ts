import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import type WebSocket from "ws";
import { getConfig } from "../config.js";

/**
 * Real interactive shell over the WebSocket (one shell per client).
 * Uses $SHELL on macOS/Linux, PowerShell on Windows — no node-pty native dep.
 */
export class TerminalManager {
  private shell: ChildProcess | null = null;
  private started = false;

  constructor(private ws: WebSocket) {}

  start() {
    if (this.started) return;
    this.started = true;
    const cwd = getConfig().workspaceRoot;
    const isWin = os.platform() === "win32";
    const shellCmd = isWin ? "powershell.exe" : process.env.SHELL || "/bin/zsh";

    this.shell = spawn(isWin ? shellCmd : shellCmd, isWin ? [] : ["-i"], {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        // Keep prompts clean inside xterm.js
        PS1: "\\[\\e[36m\\]rt-harness\\[\\e[0m\\]:\\w$ ",
      },
    });

    const onData = (chunk: Buffer | string) => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: "terminal.output", data: chunk.toString() }));
      }
    };
    this.shell.stdout?.on("data", onData);
    this.shell.stderr?.on("data", onData);
    this.shell.on("close", () => {
      this.shell = null;
      this.started = false;
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: "terminal.output", data: "\r\n[shell exited]\r\n" }));
      }
    });
    this.shell.on("error", (err) => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: "terminal.output", data: `\r\n[shell error: ${err.message}]\r\n` }));
      }
    });
  }

  input(data: string) {
    this.start();
    this.shell?.stdin?.write(data);
  }

  resize(cols: number, rows: number) {
    // Without node-pty we can't TIOCSWINSZ; clear line so output stays readable.
    if (this.shell?.stdin?.writable) {
      this.shell.stdin.write("");
    }
    void cols; void rows;
  }

  dispose() {
    this.shell?.kill();
  }
}
