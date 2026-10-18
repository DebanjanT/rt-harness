import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { Dialog, DialogContent, Button, inputClasses, Badge } from "./ui/primitives";

interface WorkspaceInfo {
  current: { path: string; name: string };
  recents: { path: string; name: string; exists: boolean; isCurrent: boolean }[];
  home: string;
}

/**
 * Workspace picker modal:
 *  - shows the current workspace root
 *  - recently opened sessions (one click to switch back)
 *  - a folder browser starting from home
 *  - create a new folder and open it
 */
export function WorkspacePicker({
  open,
  onOpenChange,
  onSwitched,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSwitched: (root: string) => void;
}) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [browseDir, setBrowseDir] = useState<string>("");
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadInfo = useCallback(async () => {
    try {
      const i = await api.getWorkspaceInfo();
      setInfo(i);
      setBrowseDir((d) => d || i.home);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      void loadInfo();
    }
  }, [open, loadInfo]);

  // Load directory entries for the browser
  useEffect(() => {
    if (!open || !browseDir) return;
    let cancelled = false;
    api
      .listDirs(browseDir)
      .then((r) => {
        if (!cancelled) setEntries(r.entries);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, browseDir]);

  const doSwitch = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.selectWorkspace(path);
      onSwitched(path);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    if (!manualPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createWorkspace(manualPath.trim());
      onSwitched(r.workspaceRoot);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Open workspace"
        description="Choose a recently opened session, browse for a folder, or create a new one. Switching restarts the terminal and reloads the explorer."
        className="w-[520px]"
      >
        {/* current */}
        {info && (
          <div className="mb-4 rounded-lg border border-line bg-surface-0 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-ink-3">Current</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-100">{info.current.name}</span>
              <span className="truncate font-mono text-[10px] text-ink-3" title={info.current.path}>
                {info.current.path}
              </span>
            </div>
          </div>
        )}

        {/* recents */}
        {info && info.recents.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-[11px] font-semibold text-ink-2">Recent sessions</div>
            <div className="space-y-1">
              {info.recents.map((r) => (
                <button
                  key={r.path}
                  disabled={busy || !r.exists || r.isCurrent}
                  onClick={() => void doSwitch(r.path)}
                  className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left
                    transition-colors disabled:opacity-45
                    ${r.isCurrent
                      ? "border-line bg-surface-0"
                      : "border-line bg-transparent hover:border-zinc-600 hover:bg-zinc-800/40"}`}
                >
                  <span className="text-xs font-medium text-zinc-200">{r.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3">{r.path}</span>
                  {r.isCurrent && <Badge>open</Badge>}
                  {!r.exists && <Badge tone="red">missing</Badge>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* folder browser */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-ink-2">Browse</span>
            {browseDir && (
              <button
                className="text-[10px] text-ink-3 hover:text-zinc-200"
                onClick={() => api.listDirs(browseDir).then((r) => setBrowseDir(r.parent)).catch(() => {})}
              >
                ↑ up
              </button>
            )}
          </div>
          <div className="mb-1.5 truncate rounded-md border border-line bg-surface-0 px-2 py-1
            font-mono text-[10px] text-ink-3" title={browseDir}>
            {browseDir}
          </div>
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-line bg-surface-0 p-1">
            {entries.length === 0 && <div className="px-2 py-1.5 text-[11px] text-ink-3">No subdirectories</div>}
            {entries.map((e) => (
              <button
                key={e.path}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs
                  text-ink-2 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
                onClick={() => setBrowseDir(e.path)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-3">
                  <path d="M1.5 3.5h4.5l1.5 2h7v8h-13v-10z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                </svg>
                <span className="truncate">{e.name}</span>
              </button>
            ))}
          </div>
          {browseDir && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              disabled={busy}
              onClick={() => void doSwitch(browseDir)}
            >
              Open this folder
            </Button>
          )}
        </div>

        {/* manual path / create */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold text-ink-2">Open or create by path</div>
          <div className="flex gap-2">
            <input
              className={inputClasses}
              placeholder="/absolute/path/to/project"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void doCreate()}
            />
            <Button variant="solid" size="sm" disabled={!manualPath.trim() || busy} onClick={() => void doCreate()}>
              Open
            </Button>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-2
            text-[11px] leading-relaxed text-red-400">{error}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
