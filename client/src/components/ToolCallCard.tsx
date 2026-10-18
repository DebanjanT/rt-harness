import { useState } from "react";
import type { ToolStep } from "../stores/chat";

const ICONS: Record<string, string> = {
  read_file: "M4 1.5h5l3 3v10H4v-13z M9 1.5v3h3", // file
  write_file: "M11 1.5l3.5 3.5L6 13.5l-4 1 1-4L11 1.5z", // pencil
  edit_file: "M11 1.5l3.5 3.5L6 13.5l-4 1 1-4L11 1.5z",
  list_directory: "M1.5 3.5h4.5l1.5 2h7v8h-13v-10z", // folder
  search_files: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zm3.5 0L14 15.5", // magnifier
  execute_command: "M3 3.5L8 8l-5 4.5 M9 12.5h4", // terminal prompt
  git_status: "M4.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM4.5 5.5V10a2.5 2.5 0 0 0 2.5 2.5h2.5",
  git_diff: "M4.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM4.5 5.5V10a2.5 2.5 0 0 0 2.5 2.5h2.5",
  git_log: "M8 4v4l2.5 2.5 M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", // clock
};

function Icon({ tool }: { tool: string }) {
  const d = ICONS[tool];
  return d ? (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0">
      {d.split(" M").map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  ) : (
    <span className="shrink-0 text-[10px]">⚙</span>
  );
}

function summarize(step: ToolStep): string {
  const a = step.args;
  switch (step.tool) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_directory":
      return String(a.path ?? "");
    case "search_files":
      return String(a.query ?? "");
    case "execute_command":
      return String(a.command ?? "");
    case "git_diff":
      return String(a.path ?? "(all)");
    default:
      return JSON.stringify(a).slice(0, 120);
  }
}

export function ToolCallCard({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);

  const statusDot =
    step.status === "running"
      ? "border-zinc-500 border-t-transparent animate-spin"
      : step.status === "ok"
        ? "bg-zinc-400"
        : "bg-red-500";

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-line bg-surface-2/60 text-xs">
      <div
        className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 transition-colors hover:bg-zinc-800/40"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full border
            ${step.status === "running" ? statusDot : `border-transparent ${statusDot}`}`}
        />
        <Icon tool={step.tool} />
        <span className="shrink-0 font-medium text-zinc-300">{step.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3" title={summarize(step)}>
          {summarize(step)}
        </span>
        <span className={`shrink-0 text-[9px] text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
      </div>
      {open && (
        <div className="max-h-56 overflow-y-auto overflow-x-auto border-t border-line bg-surface-0/60 px-2.5 py-2">
          <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-2">{JSON.stringify(step.args, null, 2)}</pre>
          {step.result && (
            <pre className="mt-2 whitespace-pre-wrap break-words border-t border-dashed border-line pt-2 text-[11px] leading-relaxed text-ink-3">
              {step.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
