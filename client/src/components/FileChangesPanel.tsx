import { useState } from "react";
import { useChatStore } from "../stores/chat";
import { api } from "../lib/api";
import { Button } from "./ui/primitives";
import type { FileChangeSummary } from "../types/agent";

/** Extension badge like the editor tabs (TS/TSX/JS/…). */
function ExtBadge({ path }: { path: string }) {
  const ext = path.split(".").pop()?.slice(0, 3).toUpperCase() ?? "?";
  return (
    <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-line bg-surface-0
      px-1 text-[8px] font-bold text-ink-3">
      {ext}
    </span>
  );
}

function KindIcon({ kind }: { kind: FileChangeSummary["kind"] }) {
  const map = {
    created: { glyph: "＋", cls: "text-emerald-400", title: "Created" },
    modified: { glyph: "✎", cls: "text-amber-400", title: "Modified" },
    deleted: { glyph: "－", cls: "text-red-400", title: "Deleted" },
    renamed: { glyph: "→", cls: "text-sky-400", title: "Renamed" },
  } as const;
  const m = map[kind];
  return (
    <span className={`shrink-0 text-[11px] ${m.cls}`} title={m.title}>
      {m.glyph}
    </span>
  );
}

/**
 * "N files changed" bar with Keep / Undo actions. Clicking a file opens the
 * Monaco diff view (DiffDialog). Rendered above the composer while the
 * session has tracked changes.
 */
export function FileChangesPanel({ onOpenDiff }: { onOpenDiff: (changeId: string) => void }) {
  const changes = useChatStore((s) => s.changes);
  const undoAllChanges = useChatStore((s) => s.undoAllChanges);
  const keepChanges = useChatStore((s) => s.keepChanges);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  if (changes.length === 0) return null;

  const totalAdded = changes.reduce((n, c) => n + c.added, 0);
  const totalRemoved = changes.reduce((n, c) => n + c.removed, 0);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-line bg-surface-2/40">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors"
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
            className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}>
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="shrink-0 text-[11px] font-semibold text-ink-2">
            {changes.length} file{changes.length === 1 ? "" : "s"} changed
          </span>
          <span className="font-mono text-[10px] text-emerald-400">+{totalAdded}</span>
          <span className="font-mono text-[10px] text-red-400">−{totalRemoved}</span>
        </button>
        <span className="flex shrink-0 gap-1.5">
          <Button variant="solid" size="xs" disabled={busy} onClick={() => void act(keepChanges)} title="Accept all changes">
            Keep
          </Button>
          <Button variant="outline" size="xs" disabled={busy} onClick={() => void act(undoAllChanges)} title="Revert all changes">
            Undo
          </Button>
        </span>
      </div>
      {open && (
        <ul className="max-h-44 overflow-y-auto px-3 pb-2">
          {changes.map((c) => (
            <li key={c.id}>
              <button
                className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-3/60"
                onClick={() => onOpenDiff(c.id)}
                title="Open diff view"
              >
                <KindIcon kind={c.kind} />
                <ExtBadge path={c.kind === "renamed" ? c.fromPath ?? c.path : c.path} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-1">
                  {c.path.split("/").pop()}
                  <span className="ml-1.5 text-[10px] text-ink-3 group-hover:hidden">
                    {c.path.split("/").slice(0, -1).join("/")}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-emerald-400">+{c.added}</span>
                <span className="shrink-0 font-mono text-[10px] text-red-400">−{c.removed}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
