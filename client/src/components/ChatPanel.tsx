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
    <Panel className="w-full">
      <PanelHeader title="Agent">
        <span className="text-[10px] text-ink-3">
          {chat.running ? `step ${chat.iteration}` : ""}
        </span>
      </PanelHeader>

      <div className="pt-2" />

      {/* plain scroll container so programmatic stick-to-bottom is reliable */}
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

      <Composer />
    </Panel>
  );
}
