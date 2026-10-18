import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chat";
import { api } from "../lib/api";
import { ToolCallCard } from "./ToolCallCard";
import { ApprovalCard } from "./ApprovalCard";
import {
  Panel, PanelHeader, ScrollArea, Button, Dropdown, DropdownTrigger,
  DropdownContent, DropdownItem, DropdownLabel, LabeledSwitch,
} from "./ui/primitives";

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-60">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ModelSelectors() {
  const { providers, providerId, model, setProvider, setModel } = useChatStore();
  const provider = providers.find((p) => p.id === providerId);

  return (
    <div className="flex gap-1.5 px-3 pb-2">
      <Dropdown>
        <DropdownTrigger asChild>
          <button className="flex h-7 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-md
            border border-line bg-surface-0 px-2 text-[11px] text-ink-2 outline-none
            transition-colors hover:border-zinc-600 hover:text-zinc-200">
            <span className="truncate">{provider?.name ?? "Select provider"}</span>
            <ChevronDown />
          </button>
        </DropdownTrigger>
        <DropdownContent>
          {providers.map((p) => (
            <DropdownItem key={p.id} selected={p.id === providerId} onSelect={() => setProvider(p.id)}>
              {p.name}
              {p.id === providerId && <span className="text-[10px]">●</span>}
            </DropdownItem>
          ))}
        </DropdownContent>
      </Dropdown>

      <Dropdown>
        <DropdownTrigger asChild>
          <button
            disabled={!provider}
            className="flex h-7 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-md
              border border-line bg-surface-0 px-2 font-mono text-[11px] text-ink-2 outline-none
              transition-colors hover:border-zinc-600 hover:text-zinc-200
              disabled:opacity-40"
          >
            <span className="truncate">{model || "Model"}</span>
            <ChevronDown />
          </button>
        </DropdownTrigger>
        <DropdownContent align="end">
          <DropdownLabel>{provider?.name ?? "Models"}</DropdownLabel>
          {(provider?.models ?? []).map((m) => (
            <DropdownItem key={m} selected={m === model} onSelect={() => setModel(m)}>
              <span className="font-mono">{m}</span>
              {m === model && <span className="text-[10px]">●</span>}
            </DropdownItem>
          ))}
          {(provider?.models ?? []).length === 0 && (
            <DropdownItem disabled>No models found</DropdownItem>
          )}
        </DropdownContent>
      </Dropdown>
    </div>
  );
}

function ChatMessage({ entry }: { entry: import("../stores/chat").ChatEntry }) {
  if (entry.role === "user") {
    return (
      <div className="ml-6 rounded-lg rounded-br-sm border border-line-strong bg-zinc-800/70
        px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-100">
        {entry.text}
      </div>
    );
  }
  return (
    <div className="mr-2 flex flex-col gap-1.5">
      {entry.steps.map((step) => <ToolCallCard key={step.id} step={step} />)}
      {entry.text && (
        <div className="rounded-lg rounded-bl-sm border border-line bg-surface-3/70 px-3 py-2
          text-[13px] leading-relaxed whitespace-pre-wrap text-ink-1">
          {entry.text}
        </div>
      )}
      {entry.streaming && <span className="stream-cursor text-accent">▊</span>}
      {entry.error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs text-red-400">
          ⚠ {entry.error}
        </div>
      )}
    </div>
  );
}

export function ChatPanel() {
  const chat = useChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.entries, chat.pendingApprovals]);

  const submit = async () => {
    const text = chat.input;
    if (!text.trim()) return;
    const attachments: { path: string; content: string }[] = [];
    for (const p of chat.pinnedPaths) {
      try {
        const f = await api.getFile(p);
        attachments.push({ path: f.path, content: f.content });
      } catch {
        /* file gone — skip */
      }
    }
    chat.send(text, attachments);
  };

  return (
    <Panel className="w-full">
      <PanelHeader title="Agent">
        <LabeledSwitch
          checked={chat.autoApprove}
          onCheckedChange={chat.toggleAutoApprove}
          label="auto"
          tooltip="Skip approval prompts (hard-blocked commands still never run)"
        />
      </PanelHeader>

      <div className="pt-2"><ModelSelectors /></div>

      <ScrollArea className="flex-1" viewportClassName="px-3">
        <div ref={scrollRef} className="min-h-full py-2">
          {chat.entries.length === 0 && (
            <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center
              text-xs leading-relaxed text-ink-3">
              Ask the agent to explore, write or fix code.
              <br />
              🐙 Pin files in the Explorer to include them as context.
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
      </ScrollArea>

      {chat.pinnedPaths.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {chat.pinnedPaths.map((p) => (
            <button
              key={p}
              onClick={() => chat.togglePin(p)}
              className="flex items-center gap-1 rounded-md border border-line bg-surface-3
                px-2 py-0.5 font-mono text-[10px] text-ink-2 transition-colors
                hover:border-zinc-600 hover:text-zinc-200"
            >
              🐙 {p.split("/").pop()} ×
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 p-3 pt-1">
        <textarea
          placeholder={chat.running
            ? "Agent is running…"
            : "Ask the agent…  (Enter to send, Shift+Enter for newline)"}
          value={chat.input}
          onChange={(e) => chat.setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          className="min-w-0 flex-1 resize-none rounded-lg border border-line bg-surface-0
            px-3 py-2 text-[13px] leading-relaxed text-ink-1 placeholder:text-ink-3
            outline-none transition-colors focus:border-zinc-600"
        />
        {chat.running ? (
          <Button variant="danger" size="md" onClick={chat.cancel} title="Stop the agent">■</Button>
        ) : (
          <Button variant="solid" size="md" onClick={() => void submit()} disabled={!chat.model}>
            Send
          </Button>
        )}
      </div>
    </Panel>
  );
}
