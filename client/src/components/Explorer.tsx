import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace";
import { useEditorStore } from "../stores/editor";
import { useChatStore } from "../stores/chat";
import { api } from "../lib/api";
import type { FileNode } from "../types/agent";
import { Panel, PanelHeader, ScrollArea, Tooltip, Button } from "./ui/primitives";

function Node({ node, depth }: { node: FileNode; depth: number }) {
  const { expanded, toggleExpand } = useWorkspaceStore();
  const { openFile, activePath } = useEditorStore();
  const { pinnedPaths, togglePin } = useChatStore();
  const isOpen = expanded.has(node.path);
  const isPinned = pinnedPaths.includes(node.path);

  const onClick = () => {
    if (node.type === "directory") toggleExpand(node.path);
    else void openFile(node.path);
  };

  return (
    <div>
      <div
        className={`group flex cursor-pointer select-none items-center gap-1.5 py-[3px] pr-1.5
          text-xs transition-colors ${activePath === node.path
            ? "bg-zinc-800/80 text-zinc-100"
            : "text-ink-2 hover:bg-zinc-800/40 hover:text-zinc-200"}`}
        style={{ paddingLeft: depth * 12 + 10 }}
        onClick={onClick}
        title={node.path}
      >
        <span className="w-3 shrink-0 text-[9px] text-ink-3">
          {node.type === "directory" ? (isOpen ? "▾" : "▸") : ""}
        </span>
        {node.type === "directory"
          ? <FolderIcon open={isOpen} />
          : <FileIcon />}
        <span className="flex-1 truncate">{node.name}</span>
        {node.type === "file" && (
          <Tooltip content={isPinned ? "Unpin from context" : "Pin to agent context"}>
            <button
              className={`shrink-0 rounded p-0.5 text-[10px] leading-none transition
                ${isPinned
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-60 hover:!opacity-100"}`}
              onClick={(e) => {
                e.stopPropagation();
                togglePin(node.path);
              }}
            >
              {isPinned ? "📌" : "🐙"}
            </button>
          </Tooltip>
        )}
      </div>
      {node.type === "directory" && isOpen && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
    </div>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-3">
      {open ? (
        <path d="M1.5 4.5v8h11l2-5.5h-11l-2 5.5v-8h4l1.5 2h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      ) : (
        <path d="M1.5 3.5h4.5l1.5 2h7v8h-13v-10z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-3">
      <path d="M4 1.5h5l3 3v10H4v-13z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function Explorer() {
  const { tree, root, loadTree, loading, error } = useWorkspaceStore();
  const [newName, setNewName] = useState("");

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    const handler = () => void loadTree();
    window.addEventListener("harness:refresh-tree", handler);
    return () => window.removeEventListener("harness:refresh-tree", handler);
  }, [loadTree]);

  const createFolder = async () => {
    if (!newName.trim()) return;
    await api.createFolder(newName.trim());
    setNewName("");
    void loadTree();
  };

  return (
    <Panel className="w-full flex-1">
      <PanelHeader title="Explorer">
        <Tooltip content="Refresh">
          <Button variant="ghost" size="xs" onClick={() => void loadTree()}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Tooltip>
      </PanelHeader>
      <div className="border-b border-line px-3 py-1.5 text-[11px] font-medium text-ink-2">
        {root.split("/").pop() || root}
      </div>
      {error && <div className="px-3 py-2 text-[11px] text-red-400">{error}</div>}
      <ScrollArea className="flex-1">
        <div className="pb-2">
          {tree.map((n) => <Node key={n.path} node={n} depth={0} />)}
          {loading && <div className="px-3 py-2 text-[11px] text-ink-3">loading…</div>}
        </div>
      </ScrollArea>
      <div className="border-t border-line p-2">
        <input
          placeholder="New folder path…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void createFolder()}
          className="w-full rounded-md border border-line bg-surface-0 px-2 py-1.5 text-[11px]
            text-ink-1 placeholder:text-ink-3 outline-none transition-colors
            focus:border-zinc-600"
        />
      </div>
    </Panel>
  );
}
