import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Dialog, DialogContent, Badge } from "./ui/primitives";
import { api } from "../lib/api";
import { RT_DARK } from "./EditorPane";

interface DiffData {
  path: string;
  kind: string;
  before: string | null;
  after: string | null;
}

/**
 * Full-screen-ish Monaco diff view for one agent file change.
 * original = before the agent touched it, modified = after.
 */
export function DiffDialog({ changeId, onClose }: { changeId: string | null; onClose: () => void }) {
  const [data, setData] = useState<DiffData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!changeId) {
      setData(null);
      setError(null);
      return;
    }
    api
      .getChangeDiff(changeId)
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, [changeId]);

  const language = data ? data.path.split(".").pop() : undefined;
  const title = data
    ? data.kind === "renamed" && data.path
      ? data.path
      : data.path
    : "Diff";

  return (
    <Dialog open={Boolean(changeId)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        title={title}
        description={data ? `${data.kind} — original (left) vs agent's version (right)` : undefined}
        className="flex h-[85vh] w-[900px] max-w-[95vw] flex-col"
      >
        {error && (
          <div className="rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-2 text-[11px] text-red-400">
            {error}
          </div>
        )}
        {!error && !data && <div className="p-4 text-xs text-ink-3">Loading diff…</div>}
        {data && (
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-line">
            <DiffEditor
              height="100%"
              language={language}
              theme="rt-dark"
              original={data.before ?? ""}
              modified={data.after ?? ""}
              options={{
                fontSize: 12,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderOverviewRuler: false,
                automaticLayout: true,
                readOnly: true,
                renderSideBySide: true,
              }}
            />
          </div>
        )}
        {data && (
          <div className="mt-2 flex items-center gap-2">
            <Badge tone={data.kind === "deleted" ? "red" : data.kind === "created" ? "green" : "amber"}>
              {data.kind}
            </Badge>
            <span className="text-[10px] text-ink-3">
              {data.before === null ? "file did not exist before" : ""}
              {data.after === null ? "file was deleted" : ""}
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
