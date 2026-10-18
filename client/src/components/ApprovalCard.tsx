import { useChatStore, type PendingApproval } from "../stores/chat";
import { Button, Badge } from "./ui/primitives";

/** Colorize +diff / -diff lines. */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="max-h-52 overflow-y-auto rounded-md border border-line bg-surface-0 p-2
      font-mono text-[11px] leading-relaxed text-ink-2">
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "";
        return (
          <span key={i} className={cls}>{line}\n</span>
        );
      })}
    </pre>
  );
}

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const resolveApproval = useChatStore((s) => s.resolveApproval);
  const kindLabel = approval.kind === "command" ? "Run command" : "Modify file";

  return (
    <div className={`my-2 rounded-lg border p-2.5 transition-colors
      ${approval.resolved === "approved"
        ? "border-emerald-900/60 bg-emerald-950/10"
        : approval.resolved === "denied"
          ? "border-red-900/60 bg-red-950/10 opacity-75"
          : "border-amber-900/70 bg-amber-950/10"}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M8 1.5L15 13.5H1L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M8 6v3.5 M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          {kindLabel} — approval required
        </span>
        <Badge tone={approval.kind === "command" ? "amber" : "neutral"}>{approval.tool}</Badge>
      </div>

      <pre className="rounded-md border border-line bg-surface-0 px-2.5 py-2 font-mono text-xs text-zinc-200">
        {approval.summary}
      </pre>

      {approval.diff && <div className="mt-2"><DiffBlock diff={approval.diff} /></div>}

      {!approval.resolved ? (
        <div className="mt-2.5 flex gap-2">
          <Button variant="solid" size="sm" onClick={() => resolveApproval(approval.id, true)}>
            Allow
          </Button>
          <Button variant="outline" size="sm" onClick={() => resolveApproval(approval.id, false)}>
            Deny
          </Button>
        </div>
      ) : (
        <div className="mt-2">
          <Badge tone={approval.resolved === "approved" ? "green" : "red"}>
            {approval.resolved === "approved" ? "Allowed" : "Denied"}
          </Badge>
        </div>
      )}
    </div>
  );
}
