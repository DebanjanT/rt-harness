import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace";
import { useEditorStore } from "../stores/editor";
import { useChatStore } from "../stores/chat";
import { api } from "../lib/api";
import type { FileNode } from "../types/agent";
import { Panel, PanelHeader, ScrollArea, Tooltip, Button } from "./ui/primitives";

/* ---------------- extension → icon glyph + color ---------------- */

const FILE_STYLES: Record<string, { glyph: string; color: string }> = {
  js: { glyph: "JS", color: "text-yellow-500" },
  mjs: { glyph: "JS", color: "text-yellow-500" },
  jsx: { glyph: "JS", color: "text-cyan-400" },
  ts: { glyph: "TS", color: "text-blue-400" },
  tsx: { glyph: "TS", color: "text-blue-300" },
  json: { glyph: "{}", color: "text-amber-400" },
  md: { glyph: "M↓", color: "text-sky-400" },
  css: { glyph: "#", color: "text-sky-500" },
  scss: { glyph: "#", color: "text-pink-400" },
  html: { glyph: "<>", color: "text-orange-500" },
  py: { glyph: "PY", color: "text-emerald-400" },
  c: { glyph: "C", color: "text-blue-500" },
  h: { glyph: "H", color: "text-purple-400" },
  cpp: { glyph: "C+", color: "text-blue-600" },
  rs: { glyph: "RS", color: "text-orange-400" },
  go: { glyph: "GO", color: "text-cyan-300" },
  sh: { glyph: "$", color: "text-zinc-400" },
  s: { glyph: "ASM", color: "text-zinc-500" },
  sql: { glyph: "DB", color: "text-rose-400" },
  yml: { glyph: "Y", color: "text-red-400" },
  yaml: { glyph: "Y", color: "text-red-400" },
  txt: { glyph: "T", color: "text-zinc-500" },
  png: { glyph: "IMG", color: "text-fuchsia-400" },
  jpg: { glyph: "IMG", color: "text-fuchsia-400" },
  jpeg: { glyph: "IMG", color: "text-fuchsia-400" },
  gif: { glyph: "IMG", color: "text-fuchsia-400" },
  svg: { glyph: "SVG", color: "text-lime-400" },
  lock: { glyph: "🔒", color: "text-zinc-500" },
};

function fileStyle(name: string): { glyph: string; color: string } {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return FILE_STYLES[ext] ?? { glyph: "•", color: "text-ink-3" };
}

/* ---------------- icons ---------------- */

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

/* ---------------- context menu ---------------- */

type MenuState = { x: number; y: number; node: FileNode } | null;

function ContextMenu({
  menu,
  onClose,
  onDelete,
  onNewFile,
  onNewFolder,
  onPin,
  onRename,
  onReveal,
}: {
  menu: NonNullable<MenuState>;
  onClose: () => void;
  onDelete: (node: FileNode) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onPin: (path: string) => void;
  onRename: (node: FileNode) => void;
  onReveal: (node: FileNode) => void;
}) {
  const { node, x, y } = menu;
  const isDir = node.type === "directory";

  const item = (label: string, action: () => void, danger = false) => (
    <button
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs
        transition-colors ${danger ? "text-red-400 hover:bg-red-950/40" : "text-ink-2 hover:bg-zinc-700/50 hover:text-zinc-100"}`}
      onClick={() => {
        action();
        onClose();
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      {/* click-away backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 w-44 overflow-hidden rounded-lg border border-line-strong bg-surface-3
          p-1 shadow-xl shadow-black/60"
        style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 220) }}
      >
        {isDir && item("New file here", () => onNewFile(node.path))}
        {isDir && item("New folder here", () => onNewFolder(node.path))}
        {!isDir && item("Pin to agent context", () => onPin(node.path))}
        {!isDir && item("Rename", () => onRename(node))}
        {item("Copy path", () => navigator.clipboard.writeText(node.path))}
        {item("Reveal in editor", () => onReveal(node))}
        <div className="my-1 border-t border-line" />
        {item("Delete", () => onDelete(node), true)}
      </div>
    </>
  );
}

/* ---------------- inline create form ---------------- */

function InlineCreate({
  kind,
  parentDir,
  onCancel,
  onCreate,
}: {
  kind: "file" | "folder";
  parentDir: string;
  onCancel: () => void;
  onCreate: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = () => {
    const n = name.trim();
    if (!n) return onCancel();
    const sep = parentDir ? "/" : "";
    onCreate(`${parentDir}${sep}${n}`);
  };

  return (
    <div className="flex items-center gap-1.5 py-1 pl-4 pr-2" style={{ marginLeft: 0 }}>
      <span className="text-[10px] text-ink-3">{kind === "file" ? "📄" : "📁"}</span>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => setTimeout(submit, 100)}
        placeholder={kind === "file" ? "name.js" : "folder"}
        className="min-w-0 flex-1 rounded border border-zinc-500 bg-surface-0 px-1.5 py-0.5
          text-[11px] text-ink-1 outline-none"
      />
    </div>
  );
}

/* ---------------- file row ---------------- */

function Node({
  node,
  depth,
  onContextMenu,
  renaming,
  onRenameCommit,
}: {
  node: FileNode;
  depth: number;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  renaming: string | null;
  onRenameCommit: (oldPath: string, newPath: string) => void;
}) {
  const { expanded, toggleExpand } = useWorkspaceStore();
  const { openFile, activePath } = useEditorStore();
  const { pinnedPaths, togglePin } = useChatStore();
  const [editingName, setEditingName] = useState<string | null>(null);
  const isOpen = expanded.has(node.path);
  const isPinned = pinnedPaths.includes(node.path);
  const style = fileStyle(node.name);

  const commitRename = () => {
    const n = editingName?.trim() ?? "";
    if (n && n !== node.name) onRenameCommit(node.path, n);
    else setEditingName(null);
  };

  return (
    <div>
      <div
        className={`group flex cursor-pointer select-none items-center gap-1.5 py-[3px] pr-1.5
          text-xs transition-colors ${activePath === node.path
            ? "bg-zinc-800/80 text-zinc-100"
            : "text-ink-2 hover:bg-zinc-800/40 hover:text-zinc-200"}`}
        style={{ paddingLeft: depth * 12 + 10 }}
        onClick={() => (node.type === "directory" ? toggleExpand(node.path) : void openFile(node.path))}
        onContextMenu={(e) => onContextMenu(e, node)}
        title={node.path}
      >
        <span className="w-3 shrink-0 text-[9px] text-ink-3">
          {node.type === "directory" ? (isOpen ? "▾" : "▸") : ""}
        </span>
        {node.type === "directory" ? (
          <FolderIcon open={isOpen} />
        ) : (
          <span className={`w-6 shrink-0 text-center font-mono text-[8px] font-bold ${style.color}`}>
            {style.glyph}
          </span>
        )}
        {renaming === node.path ? (
          <input
            autoFocus
            value={editingName ?? ""}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditingName(null);
            }}
            className="min-w-0 flex-1 rounded border border-zinc-500 bg-surface-0 px-1 py-0.5
              text-[11px] text-ink-1 outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate">{node.name}</span>
        )}
        {node.type === "file" && (
          <Tooltip content={isPinned ? "Unpin from context" : "Pin to agent context"}>
            <button
              className={`shrink-0 rounded p-0.5 text-[10px] leading-none transition
                ${isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"}`}
              onClick={(e) => {
                e.stopPropagation();
                togglePin(node.path);
              }}
            >
              🐙
            </button>
          </Tooltip>
        )}
      </div>
      {node.type === "directory" && isOpen &&
        node.children?.map((c) => (
          <Node
            key={c.path}
            node={c}
            depth={depth + 1}
            onContextMenu={onContextMenu}
            renaming={renaming}
            onRenameCommit={onRenameCommit}
          />
        ))}
    </div>
  );
}

/* ---------------- Explorer ---------------- */

export function Explorer() {
  const { tree, root, loadTree, loading, error } = useWorkspaceStore();
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [creating, setCreating] = useState<{ kind: "file" | "folder"; dir: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const togglePin = useChatStore((s) => s.togglePin);
  const openFile = useEditorStore((s) => s.openFile);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    const handler = () => void loadTree();
    window.addEventListener("harness:refresh-tree", handler);
    return () => window.removeEventListener("harness:refresh-tree", handler);
  }, [loadTree]);

  // Fuzzy search over the flattened tree
  const allFiles = useMemo(() => {
    const out: FileNode[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === "file") out.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    // fuzzy: all query chars in order
    return allFiles
      .filter((f) => {
        const n = f.name.toLowerCase();
        let i = 0;
        for (const ch of q) {
          i = n.indexOf(ch, i);
          if (i === -1) return false;
          i++;
        }
        return true;
      })
      .slice(0, 30);
  }, [search, allFiles]);

  // ---- CRUD ----
  const createEntry = async (path: string, kind: "file" | "folder") => {
    if (kind === "folder") {
      await api.createFolder(path);
    } else {
      // create empty file via save API
      await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "" }),
      });
      void openFile(path);
    }
    setCreating(null);
    void loadTree();
  };

  const deleteNode = async (node: FileNode) => {
    await api.deleteFile(node.path);
    void loadTree();
  };

  const renameNode = async (oldPath: string, newName: string) => {
    try {
      const content = await api.getFile(oldPath).catch(() => null);
      const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
      const newPath = `${parent ? parent + "/" : ""}${newName}`;
      if (content) await api.saveFile(newPath, content.content);
      else await api.createFolder(newPath);
      await api.deleteFile(oldPath);
      setRenaming(null);
      void loadTree();
    } catch (err) {
      console.error("rename failed:", err);
    }
  };

  const revealInEditor = (node: FileNode) => {
    if (node.type === "file") void openFile(node.path);
    else useWorkspaceStore.getState().toggleExpand(node.path);
  };

  const dirForCreate = creating?.dir ?? "";

  return (
    <Panel className="w-full flex-1">
      <PanelHeader title="Explorer">
        {/* new file / folder buttons */}
        <Tooltip content="New file">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setCreating({ kind: "file", dir: "" })}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8.5 1.5H4v13h8V5l-3.5-3.5z M8.5 1.5V5H12 M6 9.5h4 M8 7.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Tooltip>
        <Tooltip content="New folder">
          <Button variant="ghost" size="xs" onClick={() => setCreating({ kind: "folder", dir: "" })}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M1.5 3.5h4.5l1.5 2h7v8h-13v-10z M8 8v4 M6 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Tooltip>
        <Tooltip content="Refresh">
          <Button variant="ghost" size="xs" onClick={() => void loadTree()}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Tooltip>
      </PanelHeader>

      <div className="border-b border-line px-2 py-1.5">
        {/* search box replaces the old bottom input */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files…"
          className="w-full rounded-md border border-line bg-surface-0 px-2 py-1 text-[11px]
            text-ink-1 placeholder:text-ink-3 outline-none transition-colors focus:border-zinc-600"
        />
      </div>

      <div className="border-b border-line px-3 py-1.5 text-[11px] font-medium text-ink-2">
        {root.split("/").pop() || root}
      </div>
      {error && <div className="px-3 py-2 text-[11px] text-red-400">{error}</div>}

      <ScrollArea className="flex-1">
        <div className="pb-2">
          {searchResults ? (
            // search results mode
            <>
              <div className="px-3 py-1 text-[10px] text-ink-3">
                {searchResults.length} match{searchResults.length === 1 ? "" : "es"}
              </div>
              {searchResults.map((f) => {
                const style = fileStyle(f.name);
                return (
                  <div
                    key={f.path}
                    className="group flex cursor-pointer select-none items-center gap-1.5 py-[3px] pl-3
                      pr-1.5 text-xs text-ink-2 transition-colors hover:bg-zinc-800/40 hover:text-zinc-200"
                    onClick={() => void openFile(f.path)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, node: f });
                    }}
                    title={f.path}
                  >
                    <span className={`w-6 shrink-0 text-center font-mono text-[8px] font-bold ${style.color}`}>
                      {style.glyph}
                    </span>
                    <span className="truncate">{f.name}</span>
                    <span className="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-ink-3">
                      {f.path}
                    </span>
                  </div>
                );
              })}
            </>
          ) : (
            // tree mode
            <>
              {tree.map((n) => (
                <Node
                  key={n.path}
                  node={n}
                  depth={0}
                  onContextMenu={(e, node) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, node });
                  }}
                  renaming={renaming}
                  onRenameCommit={(oldPath, newName) => void renameNode(oldPath, newName)}
                />
              ))}
              {loading && <div className="px-3 py-2 text-[11px] text-ink-3">loading…</div>}
              {creating && creating.dir === "" && (
                <InlineCreate
                  kind={creating.kind}
                  parentDir=""
                  onCancel={() => setCreating(null)}
                  onCreate={(p) => void createEntry(p, creating.kind)}
                />
              )}
              {/* context-menu-triggered create renders at root for simplicity */}
              {creating && creating.dir !== "" && (
                <div className="px-3 py-2 text-[11px] text-ink-3">
                  creating in {creating.dir}/
                  <InlineCreate
                    kind={creating.kind}
                    parentDir={creating.dir}
                    onCancel={() => setCreating(null)}
                    onCreate={(p) => void createEntry(p, creating.kind)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onDelete={(n) => void deleteNode(n)}
          onNewFile={(dir) => setCreating({ kind: "file", dir })}
          onNewFolder={(dir) => setCreating({ kind: "folder", dir })}
          onPin={(p) => togglePin(p)}
          onRename={(n) => {
            if (n.type === "file") setRenaming(n.path);
          }}
          onReveal={revealInEditor}
        />
      )}
    </Panel>
  );
}
