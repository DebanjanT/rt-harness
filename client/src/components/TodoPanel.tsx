import { useState } from "react";
import { useChatStore } from "../stores/chat";
import type { TodoItem } from "../types/agent";

/** Green double-check (completed), blue pulsing dot (in progress), gray circle (pending). */
function StatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-emerald-400">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.2 8.2l1.9 1.9 3.7-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 animate-pulse text-sky-400">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-3">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * Live task checklist the agent maintains via todo_write. Collapsible header
 * shows progress ("Todos (3/5)"); completed items strike through.
 */
export function TodoPanel() {
  const todos = useChatStore((s) => s.todos);
  const [open, setOpen] = useState(true);
  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const pct = Math.round((done / todos.length) * 100);

  return (
    <div className="shrink-0 border-b border-line bg-surface-2/40">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-3/40"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
          className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[11px] font-semibold text-ink-2">Todos ({done}/{todos.length})</span>
        <span className="relative h-1 w-16 overflow-hidden rounded-full bg-zinc-800">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </span>
      </button>
      {open && (
        <ul className="px-3 pb-2">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 py-0.5">
              <span className="mt-0.5">
                <StatusIcon status={t.status} />
              </span>
              <span
                className={`min-w-0 flex-1 text-[12px] leading-snug break-words
                  ${t.status === "completed" ? "text-ink-3 line-through" : t.status === "in_progress" ? "font-medium text-zinc-100" : "text-ink-2"}`}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
