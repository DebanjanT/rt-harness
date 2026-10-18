import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { harnessSocket } from "../lib/websocket";
import { Panel, PanelHeader } from "./ui/primitives";

/**
 * Real PTY terminal (server-side node-pty) rendered with xterm.js.
 *
 * Mounting notes (important):
 *  - The Terminal is created SYNCHRONOUSLY inside the effect. Never gate
 *    subscription attachment behind async work: React 18 StrictMode mounts,
 *    cleans up and re-mounts effects, and an async race leaves the terminal
 *    with all input/output handlers disposed (symptom: blinking cursor that
 *    never echoes).
 *  - Resize/fit is deferred with rAF — that's cosmetic and safe to race.
 */
export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: {
        background: "#09090b",
        foreground: "#d4d4d8",
        cursor: "#d4d4d8",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        brightBlack: "#52525b",
        white: "#e4e4e7",
      },
      fontFamily: "'SF Mono', Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    term.writeln("\x1b[90m rt-harness terminal\x1b[0m \x1b[90m— type \x1b[0mexit\x1b[0m\x1b[90m to close the shell\x1b[0m");

    // Wire input/output IMMEDIATELY — no async gap.
    const dataSub = term.onData((data) => harnessSocket.send({ type: "terminal.input", data }));
    const resizeSub = term.onResize(({ cols, rows }) =>
      harnessSocket.send({ type: "terminal.resize", cols, rows }),
    );
    const off = harnessSocket.on((event) => {
      if (event.type === "terminal.output") {
        term.write(event.data);
      }
    });

    const onWsChange = () => {
      term.reset();
      term.writeln("\x1b[90m-- workspace switched, restarting shell --\x1b[0m");
    };
    window.addEventListener("harness:workspace-changed", onWsChange);

    // Fit once the layout has settled, then report size to the PTY.
    let raf = 0;
    let tries = 0;
    const fitWhenReady = () => {
      if (disposed) return;
      if (container.clientHeight > 0 || tries > 30) {
        try { fit.fit(); } catch { /* container gone */ }
        harnessSocket.send({ type: "terminal.resize", cols: term.cols, rows: term.rows });
      } else {
        tries++;
        raf = requestAnimationFrame(fitWhenReady);
      }
    };
    let disposed = false;
    raf = requestAnimationFrame(fitWhenReady);

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* gone */ }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      dataSub.dispose();
      resizeSub.dispose();
      off();
      window.removeEventListener("harness:workspace-changed", onWsChange);
      ro.disconnect();
      // Dispose the terminal itself too — the effect re-creates it cleanly on
      // the StrictMode remount (container is emptied by term.dispose()).
      try { term.dispose(); } catch { /* already gone */ }
      if (termRef.current === term) termRef.current = null;
    };
  }, []);

  return (
    <Panel className="w-full bg-surface-0">
      <PanelHeader title="Terminal" />
      <div className="min-h-0 flex-1 px-2 py-1.5">
        <div ref={containerRef} className="h-full" />
      </div>
    </Panel>
  );
}
