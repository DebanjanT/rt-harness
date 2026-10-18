import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import type { Segment } from "../stores/chat";
import { ToolCallCard } from "./ToolCallCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { Panel, PanelHeader, Badge } from "./ui/primitives";
import type { AgentMode } from "../types/agent";
import { MODES } from "../types/agent";

function ModeBadge({ mode }: { mode?: AgentMode }) {
  if (!mode || mode === "agent") return null;
  const m = MODES.find((x) => x.id === mode);
  const tone = mode === "bypass" ? "amber" : "neutral";
  return <Badge tone={tone}>{m?.label ?? mode}</Badge>;
}

function StatsBar() {
  const usage = useChatStore((s) => s.usage);
  if (!usage) return null;

  const ctxPct =
    usage.contextWindow && usage.contextWindow > 0
      ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))
      : null;

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
    : String(n);

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
        in <span className="font-mono text-ink-2">{fmt(usage.inputTokens)}</span>
        <span className="text-ink-3"> / {fmt(usage.totalInputTokens)}</span>
      </span>
      <span title="Output tokens (last / total)">
        out <span className="font-mono text-ink-2">{fmt(usage.outputTokens)}</span>
        <span className="text-ink-3"> / {fmt(usage.totalOutputTokens)}</span>
      </span>
      {ctxPct !== null ? (
        <span className="flex items-center gap-1.5" title={`Context: ${fmt(usage.contextTokens)} of ${fmt(usage.contextWindow!)} tokens`}>
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
          ctx <span className="font-mono text-ink-2">{fmt(usage.contextTokens)}</span>
        </span>
      )}
    </div>
  );
}

function AssistantSegments({ segments }: { segments: Segment[] }) {
  // Defensive: never crash on undefined/persisted-shape entries.
  const list = Array.isArray(segments) ? segments : [];
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1.5">
      {list.map((seg, i) => {
        if (!seg) return null;
        if (seg.kind === "tool") {
          return seg.step ? <ToolCallCard key={seg.step.id || i} step={seg.step} /> : null;
        }
        if (seg.kind === "approval") {
          return seg.approval ? <ApprovalCard key={seg.approval.id || i} approval={seg.approval} /> : null;
        }
        if (seg.kind === "thinking") {
          return <ThinkingBlock key={i} text={seg.text} />;
        }
        return (
          <div key={i} className="min-w-0 max-w-full overflow-hidden rounded-lg rounded-bl-sm
            border border-line bg-surface-3/70 px-3 py-2">
            <Markdown text={seg.text ?? ""} />
          </div>
        );
      })}
    </div>
  );
}

/** Light-gray reasoning block shown before the final output. */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg rounded-bl-sm border border-line/70
      bg-surface-2/50 px-3 py-2">
      <button
        className="flex w-full items-center gap-1.5 text-left text-[10px] font-semibold
          uppercase tracking-wider text-ink-3 transition-colors hover:text-ink-2"
        onClick={() => setOpen((o) => !o)}
      >
        💭 Thinking
        <span className={`text-[9px] transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
      </button>
      <div
        className={`mt-1 whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-ink-3
          ${open ? "" : "line-clamp-4"}`}
      >
        {text}
      </div>
    </div>
  );
}

function ChatMessage({ entry }: { entry: import("../stores/chat").ChatEntry }) {
  if (entry.role === "user") {
    // Thumbnail strip: images (visual thumb) + pinned @-files (chip thumb).
    const thumbs: { kind: "image" | "file"; name: string; dataUrl?: string }[] = [
      ...(entry.images ?? []).map((img) => ({ kind: "image" as const, name: img.name, dataUrl: img.dataUrl })),
    ];
    const text = (Array.isArray(entry.segments) ? entry.segments : [])
      .filter((s): s is Extract<Segment, { kind: "text" }> => s?.kind === "text")
      .map((s) => s.text)
      .join("\n");
    return (
      <div className="ml-6 flex min-w-0 flex-col items-end gap-1">
        {thumbs.length > 0 && (
          <div className="flex max-w-full flex-wrap justify-end gap-1.5">
            {thumbs.map((t, i) =>
              t.kind === "image" ? (
                <img
                  key={i}
                  src={t.dataUrl}
                  alt={t.name}
                  title={t.name}
                  className="h-14 w-14 rounded-lg border border-line object-cover"
                />
              ) : (
                <span key={i} className="flex items-center gap-1 rounded-md border border-line
                  bg-surface-3 px-1.5 py-1 text-[10px] text-ink-2">
                  📄 {t.name}
                </span>
              ),
            )}
          </div>
        )}
        {text && (
          <div className="max-w-full overflow-hidden rounded-lg rounded-br-sm border border-line-strong
            bg-zinc-800/70 px-3 py-2 text-left text-[13px] leading-relaxed whitespace-pre-wrap
            break-words text-zinc-100">
            {text}
          </div>
        )}
        <ModeBadge mode={entry.mode} />
      </div>
    );
  }
  return (
    <div className="mr-2 flex min-w-0 flex-col gap-1.5">
      <AssistantSegments segments={entry.segments} />
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
  }, [chat.entries, chat.running, atBottom, scrollToBottom]);

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
