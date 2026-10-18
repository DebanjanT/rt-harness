import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import { ToolCallCard } from "./ToolCallCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";import { Markdown } from "./Markdown";import { Panel, PanelHeader, Button, Badge } from "./ui/primitives";
import type { AgentMode } from "../types/agent";
import { MODES } from "../types/agent";

function ModeBadge({ mode }: { mode?: AgentMode }) {
  if (!mode || mode === "agent") return null;
  const m = MODES.find((x) => x.id === mode);
  const tone = mode === "bypass" ? "amber" : "neutral";
  return <Badge tone={tone}>{m?.label ?? mode}</Badge>;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Live request/token stats from the running agent (server-reported usage). */
function StatsBar() {
  const usage = useChatStore((s) => s.usage);
  if (!usage) return null;

  const ctxPct =
    usage.contextWindow && usage.contextWindow > 0
      ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))
      : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line
      bg-surface-2/60 px-3 py-1 text-[10px] text-ink-3">
      <span title="Model requests in this run">
        req <span className="font-mono text-ink-2">{usage.requests}</span>
      </span>
      <span title="Output tokens per second (last request)">
        <span className="font-mono text-ink-2">{usage.tokensPerSec}</span> tok/s
      </span>
      <span title="Input tokens (last / total)">
        in <span className="font-mono text-ink-2">{fmtTokens(usage.inputTokens)}</span>
        <span className="text-ink-3"> / {fmtTokens(usage.totalInputTokens)}</span>
      </span>
      <span title="Output tokens (last / total)">
        out <span className="font-mono text-ink-2">{fmtTokens(usage.outputTokens)}</span>
        <span className="text-ink-3"> / {fmtTokens(usage.totalOutputTokens)}</span>
      </span>
      {ctxPct !== null ? (
        <span className="flex items-center gap-1.5" title={`Context: ${fmtTokens(usage.contextTokens)} of ${fmtTokens(usage.contextWindow!)} tokens`}>
          ctx
          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800">
            <span
              className={`absolute inset-y-0 left-0 rounded-full transition-all
                ${ctxPct > 85 ? "bg-red-500" : ctxPct > 60 ? "bg-amber-500" : "bg-zinc-400"}`}
              style={{ width: `${ctxPct}%` }}
            />
          </span>
          <span className="font-mono text-ink-2">{ctxPct}%</span>
        </span>
      ) : (
        <span title="Context window size is not reported by this provider">
          ctx <span className="font-mono text-ink-2">{fmtTokens(usage.contextTokens)}</span>
        </span>
      )}
    </div>
  );
}

function ChatMessage({ entry }: { entry: import("../stores/chat").ChatEntry }) {
  if (entry.role === "user") {
    return (
      <div className="ml-6 flex min-w-0 flex-col items-end gap-1">
        {(entry.images?.length ?? 0) > 0 && (
          <div className="flex max-w-full flex-wrap justify-end gap-1.5">
            {entry.images!.map((img, i) => (
              <img
                key={i}
                src={img.dataUrl}
                alt={img.name}
                className="max-h-28 max-w-40 rounded-lg border border-line object-cover"
              />
            ))}
          </div>
        )}
        {entry.text && (
          <div className="max-w-full overflow-hidden rounded-lg rounded-br-sm border border-line-strong
            bg-zinc-800/70 px-3 py-2 text-left text-[13px] leading-relaxed whitespace-pre-wrap
            break-words text-zinc-100">
            {entry.text}
          </div>
        )}
        <ModeBadge mode={entry.mode} />
      </div>
    );
  }
  return (
    <div className="mr-2 flex min-w-0 flex-col items-stretch gap-1.5">
      {entry.steps.map((step) => <ToolCallCard key={step.id} step={step} />)}
      {entry.text && (
        <div className="min-w-0 max-w-full overflow-hidden rounded-lg rounded-bl-sm border border-line
          bg-surface-3/70 px-3 py-2">
          <Markdown text={entry.text} />
        </div>
      )}
      {entry.streaming && <span className="stream-cursor text-accent">▊</span>}
      {entry.error && (
        <div className="min-w-0 rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs
          leading-relaxed break-words text-red-400">
          ⚠ {entry.error}
        </div>
      )}
    </div>
  );
}

export function ChatPanel() {
  const chat = useChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Auto-scroll to the newest output while the user is at (or near) the bottom.
  useEffect(() => {
    if (atBottom) scrollToBottom();
  }, [chat.entries, chat.pendingApprovals, chat.running, atBottom, scrollToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  return (
    <Panel className="w-full flex-1">
      <PanelHeader title="Agent">
        <span className="text-[10px] text-ink-3">
          {chat.running ? `step ${chat.iteration}` : ""}
        </span>
      </PanelHeader>

      <StatsBar />

      {/* plain scroll container so programmatic stick-to-bottom is reliable.
          Flex-1 min-h-0 keeps the Composer pinned to the bottom edge. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3"
      >
        <div className="flex min-h-full min-w-0 flex-col py-2 overflow-x-hidden">
          {chat.entries.length === 0 && (
            <div className="my-auto rounded-lg border border-dashed border-line px-4 py-8
              text-center text-xs leading-relaxed text-ink-3">
              Ask the agent to explore, write or fix code.
              <br />
              Type <span className="font-mono text-ink-2">@</span> to add files as context,
              <span className="font-mono text-ink-2"> +</span> to attach images.
            </div>
          )}
          <div className="flex flex-col gap-2.5">
            {chat.entries.map((entry, i) => <ChatMessage key={i} entry={entry} />)}
          </div>
          {chat.running && chat.iteration > 0 && (
            <div className="py-2 text-center text-[11px] italic text-ink-3">
              agent working… step {chat.iteration}
            </div>
          )}
          {chat.pendingApprovals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </div>

        {/* jump to bottom */}
        {!atBottom && (
          <button
            onClick={() => scrollToBottom(true)}
            className="sticky bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full
              border border-line-strong bg-surface-3 px-3 py-1 text-[10px] text-ink-2
              shadow-lg shadow-black/50 transition-colors hover:text-zinc-100"
          >
            ↓ latest
          </button>
        )}
      </div>

      {/* Composer is the last flex child — always pinned to the bottom. */}
      <div className="shrink-0">
        <Composer />
      </div>
    </Panel>
  );
}
