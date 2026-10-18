import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { harnessSocket } from "../lib/websocket";
import { Panel, PanelHeader } from "./ui/primitives";

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanupFns: (() => void)[] = [];

    const init = async () => {
      const container = containerRef.current;
      if (!container || termRef.current) return;

      // Wait until the container has real dimensions (flex layout settling),
      // otherwise xterm's viewport throws on init.
      for (let i = 0; i < 20 && container.clientHeight === 0; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (disposed) return;

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
      fit.fit();
      termRef.current = term;
      term.writeln("\x1b[90m rt-harness terminal\x1b[0m \x1b[90m— type \x1b[0mexit\x1b[0m\x1b[90m to close the shell\x1b[0m");
      const dataSub = term.onData((data) => harnessSocket.send({ type: "terminal.input", data }));
      const resizeSub = term.onResize(({ cols, rows }) => harnessSocket.send({ type: "terminal.resize", cols, rows }));

      const off = harnessSocket.on((event) => {
        if (event.type === "terminal.output") {
          term.write(event.data);
        }
      });

      const ro = new ResizeObserver(() => fit.fit());
      ro.observe(container);

      cleanupFns = [
        () => dataSub.dispose(),
        () => resizeSub.dispose(),
        off,
        () => ro.disconnect(),
      ];
    };

    void init();

    return () => {
      disposed = true;
      for (const fn of cleanupFns) fn();
      // Don't dispose the Terminal itself in dev (StrictMode double-mount makes
      // xterm's async viewport teardown throw); it lives for the app's lifetime.
    };
  }, []);

  return (
    <Panel className="w-full bg-surface-0">
      <PanelHeader title="Terminal" />
      <div className="min-h-0 flex-1 px-2 pb-1.5">
        <div ref={containerRef} className="h-full" />
      </div>
    </Panel>
  );
}
