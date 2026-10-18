import { useEffect } from "react";
import { Explorer } from "./components/Explorer";
import { EditorPane } from "./components/EditorPane";
import { ChatPanel } from "./components/ChatPanel";
import { TerminalPane } from "./components/TerminalPane";
import { harnessSocket } from "./lib/websocket";
import { useChatStore } from "./stores/chat";

export default function App() {
  const handleEvent = useChatStore((s) => s.handleEvent);
  const init = useChatStore((s) => s.init);

  useEffect(() => {
    harnessSocket.connect();
    const off = harnessSocket.on((event) => {
      // Route harness-wide side effects first
      if (event.type === "file.changed") {
        window.dispatchEvent(new CustomEvent("harness:file-changed", { detail: event.path }));
        window.dispatchEvent(new CustomEvent("harness:refresh-tree"));
      }
      if (event.type === "terminal.output") return; // TerminalPane subscribes itself
      handleEvent(event);
    });
    void init();
    return off;
  }, [handleEvent, init]);

  return (
    <div className="flex h-screen flex-col bg-surface-1 text-ink-1">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface-2 px-3">
        <span className="flex h-4 w-4 items-center justify-center rounded-[5px] bg-zinc-200 text-[9px] font-bold text-zinc-950">
          rt
        </span>
        <span className="text-xs font-semibold tracking-tight">rt-harness</span>
        <span className="text-[10px] text-ink-3">local AI coding harness</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface-2">
          <Explorer />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1"><EditorPane /></div>
          <div className="flex h-[240px] shrink-0 border-t border-line"><TerminalPane /></div>
        </main>
        <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-surface-2">
          <ChatPanel />
        </aside>
      </div>
    </div>
  );
}
