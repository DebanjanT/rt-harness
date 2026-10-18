import { useEffect } from "react";
import Editor from "@monaco-editor/react";
import { useEditorStore } from "../stores/editor";
import { Button, Panel } from "./ui/primitives";

export function EditorPane() {
  const { tabs, activePath, setActive, closeTab, updateContent, saveTab, reloadIfOpen } = useEditorStore();
  const active = tabs.find((t) => t.path === activePath) ?? null;

  // When the agent edits the currently open file, refresh it (unless user has edits).
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      void reloadIfOpen(path);
    };
    window.addEventListener("harness:file-changed", handler);
    return () => window.removeEventListener("harness:file-changed", handler);
  }, [reloadIfOpen]);

  return (
    <Panel className="w-full bg-surface-0">
      {/* tab bar */}
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface-2">
        {tabs.map((t) => (
          <div
            key={t.path}
            onClick={() => setActive(t.path)}
            className={`group flex cursor-pointer select-none items-center gap-2 border-r border-line
              px-3 text-xs transition-colors ${t.path === activePath
                ? "bg-surface-0 text-zinc-100"
                : "text-ink-3 hover:bg-zinc-800/40 hover:text-zinc-300"}`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dirty ? "bg-zinc-400" : "bg-transparent"}`} />
            <span className="whitespace-nowrap">{t.path.split("/").pop()}</span>
            <button
              className="rounded p-px text-[13px] leading-none text-ink-3 opacity-0 transition
                hover:text-zinc-100 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {active ? (
        <>
          <div className="min-h-0 flex-1">
            <Editor
              height="100%"
              theme="vs-dark"
              language={active.language}
              value={active.content}
              onChange={(v) => updateContent(active.path, v ?? "")}
              options={{
                fontSize: 13,
                fontFamily: "'SF Mono', Menlo, Monaco, Consolas, monospace",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                padding: { top: 10 },
              }}
            />
          </div>
          <div className="flex h-8 shrink-0 items-center justify-between border-t border-line bg-surface-2 px-3">
            <span className="text-[11px] text-ink-3">{active.path}</span>
            <Button
              variant={active.dirty ? "solid" : "ghost"}
              size="xs"
              disabled={!active.dirty}
              onClick={() => void saveTab(active.path)}
            >
              {active.dirty ? "Save" : "Saved"}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl
              border border-line bg-surface-2 text-lg font-semibold text-ink-3">rt</div>
            <h2 className="mb-1.5 text-sm font-semibold text-zinc-200">No file open</h2>
            <p className="text-xs text-ink-3">
              Open a file from the Explorer, or ask the agent to do it.
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}
