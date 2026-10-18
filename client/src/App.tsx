import { useEffect, useState } from "react";
import { Explorer } from "./components/Explorer";
import { EditorPane } from "./components/EditorPane";
import { ChatPanel } from "./components/ChatPanel";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { api } from "./lib/api";
import { harnessSocket } from "./lib/websocket";
import { useChatStore } from "./stores/chat";
import { useWorkspaceStore } from "./stores/workspace";
import { useResizable } from "./lib/useResizable";

/** Grip dots shown inside a divider on hover. */
function GripDots({ vertical }: { vertical: boolean }) {
  const dots = Array.from({ length: vertical ? 3 : 7 });
  return (
    <div
      className={`flex items-center justify-center gap-[2px] rounded-full bg-zinc-400/90 px-[3px] py-[7px]
        shadow-sm shadow-black/50 ${vertical ? "" : "rotate-90"}`}
    >
      {dots.map((_, i) => (
        <span key={i} className="h-[3px] w-[3px] rounded-full bg-zinc-700" />
      ))}
    </div>
  );
}

/**
 * Thin drag divider. Highlight on hover, bright + grip icon while hovered,
 * accent line while dragging.
 */
function Divider({
  onPointerDown,
  orientation,
  dragging,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  orientation: "vertical" | "horizontal";
  dragging: boolean;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={`group/div relative z-10 flex shrink-0 items-center justify-center
        ${orientation === "vertical" ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize"}
        transition-colors duration-100
        ${dragging
          ? "bg-zinc-500/60"
          : "bg-line hover:bg-zinc-600/50"}`}
      title={undefined}
      role="separator"
      aria-orientation={orientation}
    >
      {/* grip icon appears on hover / drag */}
      <div
        className={`pointer-events-none absolute opacity-0 transition-opacity
          group-hover/div:opacity-100 ${dragging ? "opacity-100" : ""}`}
      >
        <GripDots vertical={orientation === "vertical"} />
      </div>
    </div>
  );
}

export default function App() {
  const handleEvent = useChatStore((s) => s.handleEvent);
  const init = useChatStore((s) => s.init);
  const loadTree = useWorkspaceStore((s) => s.loadTree);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");

  const explorer = useResizable(220, { min: 140, max: 420, direction: "left", localStorageKey: "rt.explorerW" });
  const chat = useResizable(430, { min: 300, max: 720, direction: "right", localStorageKey: "rt.chatW" });
  const terminal = useResizable(240, { min: 100, max: 600, direction: "top", localStorageKey: "rt.termH" });

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

  // Load the current workspace name for the titlebar.
  useEffect(() => {
    api.getWorkspaceInfo().then((i) => setWorkspaceName(i.current.name)).catch(() => {});
  }, []);

  const onWorkspaceSwitched = (root: string) => {
    setWorkspaceName(root.split("/").pop() || root);
    // Reload the explorer tree; the terminal restarts itself on file.changed "*".
    void loadTree();
    window.dispatchEvent(new CustomEvent("harness:workspace-changed", { detail: root }));
  };

  return (
    <div className="flex h-screen flex-col bg-surface-1 text-ink-1">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface-2 px-3">
        <span className="flex h-4 w-4 items-center justify-center rounded-[5px] bg-zinc-200 text-[9px] font-bold text-zinc-950">
          rt
        </span>
        <span className="text-xs font-semibold tracking-tight">rt-harness</span>
        <button
          onClick={() => setWorkspaceOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface-0 px-2
            py-0.5 text-[11px] text-ink-2 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          title="Switch workspace"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="text-ink-3">
            <path d="M1.5 3.5h4.5l1.5 2h7v8h-13v-10z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {workspaceName || "workspace"}
        </button>
        <span className="text-[10px] text-ink-3">local AI coding harness</span>
      </header>

      <WorkspacePicker
        open={workspaceOpen}
        onOpenChange={setWorkspaceOpen}
        onSwitched={onWorkspaceSwitched}
      />

      <div className="flex min-h-0 flex-1">
        {/* Explorer — resizable right edge */}
        <aside
          className="flex shrink-0 flex-col bg-surface-2"
          style={{ width: explorer.size }}
        >
          <Explorer />
        </aside>
        <Divider orientation="vertical" dragging={explorer.dragging} onPointerDown={explorer.onPointerDown} />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1"><EditorPane /></div>
          <Divider orientation="horizontal" dragging={terminal.dragging} onPointerDown={terminal.onPointerDown} />
          <div className="flex shrink-0 border-t-0" style={{ height: terminal.size }}>
            <TerminalPane />
          </div>
        </main>

        <Divider orientation="vertical" dragging={chat.dragging} onPointerDown={chat.onPointerDown} />
        {/* Chat — resizable left edge */}
        <aside
          className="flex shrink-0 flex-col bg-surface-2"
          style={{ width: chat.size }}
        >
          <ChatPanel />
        </aside>
      </div>
    </div>
  );
}
