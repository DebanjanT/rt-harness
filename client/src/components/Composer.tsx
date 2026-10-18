import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import { useWorkspaceStore } from "../stores/workspace";
import { api } from "../lib/api";
import type { FileNode, AgentMode, ToolPermission, ThinkingEffort } from "../types/agent";
import { MODES, KNOWN_TOOLS, THINKING_LEVELS } from "../types/agent";
import { ModelSwitcher } from "./ModelSwitcher";
import {
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel,
  Popover, PopoverTrigger, PopoverContent, Button, Tooltip, Badge,
} from "./ui/primitives";

/* ---------------- icons ---------------- */

const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const ImageIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="6" cy="7" r="1.2" fill="currentColor" />
    <path d="M3 12l3.5-3.5L9 11l2-2 2.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);
const FilePlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M8.5 1.5H4v13h8V5l-3.5-3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M8.5 1.5V5H12M6 9.5h4M8 7.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
const WrenchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M10.5 2a3.5 3.5 0 0 0-3.4 4.4L2.5 11l2.5 2.5 4.6-4.6A3.5 3.5 0 0 0 14 5.5L11.8 7.7l-1.5-1.5L12.5 4A3.5 3.5 0 0 0 10.5 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

/* ---------------- @-mention file picker ---------------- */

function flattenFiles(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

function FileMentionList({
  matches,
  selectedIdx,
  onPick,
  onHover,
}: {
  matches: string[];
  selectedIdx: number;
  onPick: (path: string) => void;
  onHover: (idx: number) => void;
}) {
  if (matches.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 z-40 mb-1.5 w-full overflow-hidden rounded-lg
      border border-line-strong bg-surface-3 shadow-xl shadow-black/60">
      <div className="border-b border-line px-2.5 py-1 text-[10px] text-ink-3">
        Add file context — ↑↓ to navigate, Enter to select
      </div>
      {matches.map((f, i) => (
        <button
          key={f}
          className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors
            ${i === selectedIdx ? "bg-zinc-700/50 text-zinc-100" : "text-ink-2 hover:bg-zinc-800/60"}`}
          onClick={() => onPick(f)}
          onMouseEnter={() => onHover(i)}
        >
          <span className="font-mono text-[10px] text-ink-3">@</span>
          <span className="truncate font-mono">{f}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------- tools permission popover ---------------- */

function ToolsPermissionPopover() {
  const { toolPermissions, setToolPermission } = useChatStore();
  const overrides = Object.keys(toolPermissions).length;

  return (
    <Popover>
      <Tooltip content="Configure tool permissions">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="relative">
            <WrenchIcon />
            {overrides > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center
                rounded-full bg-zinc-300 text-[8px] font-bold text-zinc-900">{overrides}</span>
            )}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end">
        <div className="mb-2 text-[11px] font-semibold text-zinc-200">Tool permissions</div>
        <div className="mb-2 text-[10px] leading-relaxed text-ink-3">
          Control how the agent may use each tool. Disabled tools are never executed;
          "auto" runs without approval. System-dangerous commands stay hard-blocked regardless.
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {KNOWN_TOOLS.map((tool) => {
            const value: ToolPermission = toolPermissions[tool] ?? "approval";
            return (
              <div key={tool} className="flex items-center justify-between gap-2 rounded-md px-1 py-1">
                <span className="truncate font-mono text-[11px] text-ink-2">{tool}</span>
                <select
                  value={value}
                  onChange={(e) => setToolPermission(tool, e.target.value as ToolPermission)}
                  className={`rounded border px-1.5 py-0.5 text-[10px] outline-none
                    ${value === "disabled"
                      ? "border-red-900/60 bg-red-950/30 text-red-400"
                      : value === "auto"
                        ? "border-emerald-900/60 bg-emerald-950/30 text-emerald-400"
                        : "border-line bg-surface-0 text-ink-2"}`}
                >
                  <option value="auto">auto</option>
                  <option value="approval">approval</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- thinking effort selector ---------------- */

function ThinkingSelector() {
  const { thinkingEffort, setThinkingEffort } = useChatStore();
  const current = THINKING_LEVELS.find((l) => l.id === thinkingEffort)!;

  return (
    <Dropdown>
      <Tooltip content="Reasoning depth — only shown for models that accept reasoning_effort">
        <DropdownTrigger asChild>
          <Button variant="ghost" size="sm" className={thinkingEffort !== "off" ? "text-zinc-100" : ""}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path d="M8 1.5a4.5 4.5 0 0 1 4.5 4.5c0 1.7-.9 2.9-1.7 3.9-.5.7-.8 1.2-.8 2.1h-4c0-.9-.3-1.4-.8-2.1C4.4 8.9 3.5 7.7 3.5 6A4.5 4.5 0 0 1 8 1.5zM6 14h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {current.label.replace("Thinking: ", "")}
          </Button>
        </DropdownTrigger>
      </Tooltip>
      <DropdownContent>
        <DropdownLabel>Reasoning effort</DropdownLabel>
        {THINKING_LEVELS.map((l) => (
          <DropdownItem key={l.id} selected={l.id === thinkingEffort} onSelect={() => setThinkingEffort(l.id)}>
            {l.label}
            {l.id === thinkingEffort && <span className="text-[10px]">●</span>}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}

/* ---------------- mode selector ---------------- */

function ModeSelector() {
  const { mode, setMode, running } = useChatStore();
  const current = MODES.find((m) => m.id === mode)!;

  return (
    <Dropdown>
      <Tooltip content={current.hint}>
        <DropdownTrigger asChild>
          <Button variant="ghost" size="sm" disabled={running}>
            {current.label}
            <svg width="8" height="8" viewBox="0 0 16 16" fill="none" className="opacity-60">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </DropdownTrigger>
      </Tooltip>
      <DropdownContent>
        <DropdownLabel>Interaction mode</DropdownLabel>
        {MODES.map((m) => (
          <DropdownItem key={m.id} selected={m.id === mode} onSelect={() => setMode(m.id)}>
            <span className="flex flex-col">
              <span>{m.label}</span>
              <span className="text-[10px] text-ink-3">{m.hint}</span>
            </span>
            {m.id === mode && <span className="text-[10px]">●</span>}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}

/* ---------------- the Composer ---------------- */

export function Composer() {
  const chat = useChatStore();
  const loadTree = useWorkspaceStore((s) => s.loadTree);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // @-mention state: the active "@query" being typed, if any
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionQueryRef = useRef<string | null>(null);
  mentionQueryRef.current = mentionQuery;

  // Mention candidate list (computed here so keyboard nav works).
  const tree = useWorkspaceStore((s) => s.tree);
  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const all: string[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === "file") all.push(n.path);
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    const q = mentionQuery.toLowerCase();
    return all
      .filter((f) => !chat.pinnedPaths.includes(f))
      .filter((f) => (q ? f.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [mentionQuery, tree, chat.pinnedPaths]);

  useEffect(() => setMentionIdx(0), [mentionQuery]);

  // capability probe when provider+model changes
  useEffect(() => {
    if (!chat.providerId || !chat.model) return;
    let cancelled = false;
    (async () => {
      useChatStore.setState({ capabilitiesLoading: true, capabilities: null });
      try {
        const caps = await api.getCapabilities(chat.providerId, chat.model);
        if (!cancelled) useChatStore.setState({ capabilities: caps, capabilitiesLoading: false });
      } catch {
        if (!cancelled) useChatStore.setState({ capabilitiesLoading: false });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.providerId, chat.model]);

  // refresh tree so @-mention has fresh files
  useEffect(() => { void loadTree(); }, [loadTree]);

  const handleChange = (value: string) => {
    chat.setInput(value);
    // Detect "@query" right before the caret (last token starting with @).
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = before.match(/(^|\s)@([\w./-]*)$/);
    setMentionQuery(m ? m[2] : null);
  };

  const pickFile = (path: string) => {
    chat.togglePin(path);
    // remove the "@query" token from the input
    const q = mentionQueryRef.current;
    if (q !== null) {
      const re = new RegExp(`(^|\\s)@${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      chat.setInput(chat.input.replace(re, ""));
    }
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention picker takes precedence while open.
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickFile(mentionMatches[Math.min(mentionIdx, mentionMatches.length - 1)]);
        return;
      }
    }
    if (mentionQuery !== null && e.key === "Escape") {
      setMentionQuery(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const [emptySendNotice, setEmptySendNotice] = useState<string | null>(null);

  const submit = async () => {
    if (chat.running) return;
    const hasText = chat.input.trim().length > 0;
    const hasContext = chat.pinnedPaths.length > 0 || chat.images.length > 0;

    // Guard: nothing to send — explain instead of silently no-op or firing an
    // empty request at the model.
    if (!hasText && !hasContext) {
      setEmptySendNotice(
        "Nothing to send — type a message, or attach context first (@ file or + image). " +
          "A request with no text and no context is not sent to the model.",
      );
      window.setTimeout(() => setEmptySendNotice(null), 5000);
      return;
    }
    // Context-only is fine, but let the user know how the model will treat it.
    if (!hasText && hasContext) {
      setEmptySendNotice(
        "Sent context only — the model will describe/summarize the attached content.",
      );
      window.setTimeout(() => setEmptySendNotice(null), 4000);
    }

    if (chat.images.length > 0 && chat.capabilities && !chat.capabilities.vision) {
      // Vision-guard: refuse BEFORE sending. Pushed as a proper assistant
      // entry (with segments!) so the timeline stays consistent.
      useChatStore.setState((s) => ({
        entries: [...s.entries,
          { role: "user", segments: [{ kind: "text", text: chat.input }], images: [...chat.images] } as never,
          {
            role: "assistant",
            segments: [],
            error: `The selected model "${chat.model}" does not support image input (vision). ` +
              "Remove the image(s) or switch to a vision-capable model.",
          } as never],
      }));
      return;
    }
    setMentionQuery(null);
    await chat.send(chat.input);
  };

  const visionBlocked = chat.images.length > 0 && chat.capabilities && !chat.capabilities.vision;

  return (
    <div className="border-t border-line p-2.5">
      {/* context chips: @ files + images */}
      {(chat.pinnedPaths.length > 0 || chat.images.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chat.pinnedPaths.map((p) => (
            <button key={p} onClick={() => chat.togglePin(p)}
              className="flex items-center gap-1 rounded-md border border-line bg-surface-3
                px-2 py-0.5 font-mono text-[10px] text-ink-2 transition-colors
                hover:border-zinc-600 hover:text-zinc-200"
              title={`Remove @${p}`}>
              <span className="text-[9px] text-ink-3">@</span>{p.split("/").pop()} ×
            </button>
          ))}
          {chat.images.map((img, i) => (
            <button key={i} onClick={() => chat.removeImage(i)}
              className="group relative h-9 w-9 overflow-hidden rounded-md border border-line
                transition-colors hover:border-red-800"
              title={`Remove ${img.name}`}>
              <img src={img.dataUrl} alt={img.name} className="h-full w-full object-cover" />
              <span className="absolute inset-0 hidden items-center justify-center bg-black/60
                text-[10px] text-white group-hover:flex">×</span>
            </button>
          ))}
        </div>
      )}

      {/* capability badges / warnings */}
      {(chat.capabilitiesLoading || chat.capabilities) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {chat.capabilitiesLoading && <span className="text-[10px] text-ink-3">checking model capabilities…</span>}
          {chat.capabilities && (
            <>
              <Badge tone={chat.capabilities.tools ? "green" : "amber"}>
                {chat.capabilities.tools ? "🔧 tools" : "no native tools → text fallback"}
              </Badge>
              <Badge tone={chat.capabilities.vision ? "green" : "neutral"}>
                {chat.capabilities.vision ? "👁 vision" : "no vision"}
              </Badge>
              {chat.capabilities.notes.map((n, i) => (
                <span key={i} className="text-[10px] text-amber-400/90">{n}</span>
              ))}
            </>
          )}
        </div>
      )}
      {visionBlocked && (
        <div className="mb-2 rounded-md border border-red-900/60 bg-red-950/20 px-2.5 py-1.5
          text-[11px] text-red-400">
          This model can't process images. Remove the attachment or pick a vision-capable model.
        </div>
      )}

      {/* empty-send / context-only notice */}
      {emptySendNotice && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-amber-900/60
          bg-amber-950/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-400">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="mt-px shrink-0">
            <path d="M8 1.5L15 13.5H1L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M8 6v3.5 M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          {emptySendNotice}
        </div>
      )}

      {/* input row with @-mention picker */}
      <div className="relative flex items-end gap-2">
        <div className="relative min-w-0 flex-1">
          {mentionQuery !== null && (
            <FileMentionList
              matches={mentionMatches}
              selectedIdx={mentionIdx}
              onPick={pickFile}
              onHover={setMentionIdx}
            />
          )}
          <textarea
            ref={textareaRef}
            placeholder={
              chat.running
                ? "Agent is running…"
                : "Ask the agent…  @ to add files, + for images (Enter to send)"
            }
            value={chat.input}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            className="w-full resize-none rounded-lg border border-line bg-surface-0
              px-3 py-2 text-[13px] leading-relaxed text-ink-1 placeholder:text-ink-3
              outline-none transition-colors focus:border-zinc-600"
          />
        </div>
        {chat.running ? (
          <Button variant="danger" size="md" onClick={chat.cancel} title="Stop the agent">■</Button>
        ) : (
          <Button variant="solid" size="md" onClick={() => void submit()} disabled={!chat.model}>
            Send
          </Button>
        )}
      </div>

      {/* toolbar: + / mode / model / tools */}
      <div className="mt-2 flex items-center gap-1">
        <Dropdown>
          <Tooltip content="Add context">
            <DropdownTrigger asChild>
              <Button variant="ghost" size="sm"><PlusIcon /></Button>
            </DropdownTrigger>
          </Tooltip>
          <DropdownContent>
            <DropdownItem onSelect={() => fileInputRef.current?.click()}>
              <span className="flex items-center gap-2"><ImageIcon /> Upload image…</span>
              <span className="text-[10px] text-ink-3">vision models</span>
            </DropdownItem>
            <DropdownItem onSelect={() => {
              // focus textarea and prefill "@" to open the file picker
              textareaRef.current?.focus();
              chat.setInput(chat.input + (chat.input.endsWith("@") || chat.input === "" ? "@" : " @"));
              // place caret at end & trigger mention detection
              requestAnimationFrame(() => {
                const ta = textareaRef.current;
                if (ta) {
                  ta.selectionStart = ta.selectionEnd = ta.value.length;
                  handleChange(ta.value);
                }
              });
            }}>
              <span className="flex items-center gap-2"><FilePlusIcon /> Add file from workspace…</span>
              <span className="text-[10px] text-ink-3">@</span>
            </DropdownItem>
          </DropdownContent>
        </Dropdown>

        <ModeSelector />
        {/* Thinking selector only for models that accept reasoning_effort */}
        {chat.capabilities?.thinking && <ThinkingSelector />}
        <ModelSwitcher />
        <div className="flex-1" />
        <ToolsPermissionPopover />

        {/* hidden image input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void chat.addImages(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
