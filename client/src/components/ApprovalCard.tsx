import { useState } from "react";
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

/**
 * Compact inline approval card. Lives inside the assistant timeline exactly
 * where the model requested it (after its text/tool call), so the flow reads:
 * model text → approval → (after Allow) model continues.
 *
 * Layout: one header row (kind · tool · Allow/Deny) + one summary line +
 * a collapsed "view diff" toggle.
 */
export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const resolveApproval = useChatStore((s) => s.resolveApproval);
  const [showDiff, setShowDiff] = useState(false);
  const kindLabel =
    approval.kind === "command"
      ? "Run command"
      : approval.kind === "question"
        ? "Question"
        : "Modify file";

  // ---- question kind: show options as clickable answer buttons -------------
  if (approval.kind === "question") {
    const options = Array.isArray(approval.data?.options)
      ? (approval.data.options as string[])
      : (approval.options ?? []);
    return (
      <div className={`my-0.5 min-w-0 max-w-full overflow-hidden rounded-lg border transition-colors
        ${approval.resolved
          ? "border-line bg-surface-0 opacity-75"
          : "border-sky-900/70 bg-sky-950/10"}`}>
        <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-sky-400">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.6-.8 1.2 M8 11v.3"
              stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span className="shrink-0 text-[11px] font-semibold text-sky-400">Question</span>
          <Badge tone="neutral">{approval.tool}</Badge>
        </div>
        <div className="px-2.5 pb-2">
          <div className="mb-1.5 text-[12px] text-ink-1">{approval.summary}</div>
          {approval.resolved ? (
            <Badge tone="neutral">Answered</Badge>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {options.map((opt) => (
                <Button key={opt} variant="outline" size="xs" onClick={() => resolveApproval(approval.id, true, opt)}>
                  {opt}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`my-0.5 min-w-0 max-w-full overflow-hidden rounded-lg border transition-colors
      ${approval.resolved === "approved"
        ? "border-emerald-900/60 bg-emerald-950/10"
        : approval.resolved === "denied"
          ? "border-red-900/60 bg-red-950/10 opacity-75"
          : "border-amber-900/70 bg-amber-950/10"}`}>
      {/* header row: kind · badge · actions */}
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-amber-400">
          <path d="M8 1.5L15 13.5H1L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M8 6v3.5 M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <span className="shrink-0 text-[11px] font-semibold text-amber-400">{kindLabel}</span>
        <Badge tone={approval.kind === "command" ? "amber" : "neutral"}>{approval.tool}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2" title={approval.summary}>
          {approval.summary}
        </span>
        {!approval.resolved ? (
          <span className="flex shrink-0 gap-1.5">
            <Button variant="solid" size="xs" onClick={() => resolveApproval(approval.id, true)}>
              Allow
            </Button>
            <Button variant="outline" size="xs" onClick={() => resolveApproval(approval.id, false)}>
              Deny
            </Button>
          </span>
        ) : (
          <Badge tone={approval.resolved === "approved" ? "green" : "red"}>
            {approval.resolved === "approved" ? "Allowed" : "Denied"}
          </Badge>
        )}
      </div>

      {/* diff toggle (only for file writes) */}
      {approval.diff && (
        <div className="px-2.5 pb-1.5">
          <button
            className="text-[10px] text-ink-3 underline decoration-zinc-700 underline-offset-2
              transition-colors hover:text-zinc-200"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? "hide diff" : "view diff"}
          </button>
          {showDiff && (
            <div className="mt-1.5">
              <DiffBlock diff={approval.diff} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
