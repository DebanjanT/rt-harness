# rt-harness

A web-based, VS Code–like AI coding harness that runs **fully locally** against
OpenAI-compatible model servers (Ollama, FreeToken, LM Studio, vLLM, …).

```
┌──────────────────────────────────────────┐
│            Web IDE (React+Vite)          │
│  Explorer │ Monaco Editor │ AI Chat      │
│              xterm Terminal              │
└───────────────────┬──────────────────────┘
                    │ REST + WebSocket
┌───────────────────▼──────────────────────┐
│            Node Agent Runtime            │
│  Agent loop · Tool registry · Approval   │
│  Context builder · Path/Command policy   │
└───────────────────┬──────────────────────┘
                    │ OpenAI SDK (streaming)
        ┌───────────▼───────────┐
        │  Ollama :11434  / or  │
        │  FreeToken :1919  /v1 │
        └───────────────────────┘
```

## Features

- **VS Code-like UI** — file explorer, Monaco editor with tabs, streaming chat panel, real terminal
- **Agent loop with tool calling** — the model can read/write/edit/search files, run commands and inspect git, looping until the task is done
- **Approval system** — every shell command and file write can require your explicit Allow/Deny (diff preview for edits)
- **Streaming** — tokens stream live over WebSocket; tool calls render as activity cards
- **Multi-provider** — switch between Ollama / FreeToken / any OpenAI-compatible endpoint and any installed model at runtime
- **Sandboxed workspace** — all file access is confined to the workspace root (path traversal blocked); dangerous commands are hard-blocked

## Quick start

```bash
# 1. install everything
npm install && npm install --prefix server && npm install --prefix client

# 2. start Ollama (or FreeToken) and pull a model
ollama serve
ollama pull qwen3-coder:30b

# 3. run the harness
npm run dev
```

- Web IDE → http://localhost:5173
- Agent API → http://localhost:8787

Edit `harness.config.json` to point providers at your servers and set the
workspace root the agent operates on.

## Architecture

| Path | Purpose |
|---|---|
| `server/src/agent/AgentLoop.ts` | Core agent loop: stream → tool calls → execute → repeat |
| `server/src/agent/ToolRegistry.ts` | Tool schema registry exposed to the model |
| `server/src/tools/` | read/write/edit/search/list files, terminal, git |
| `server/src/security/` | Path sandboxing + dangerous-command policy |
| `server/src/ws/` | WebSocket protocol (agent events, terminal, approvals) |
| `client/src/components/` | Explorer, Editor, Chat, ToolCallCard, Terminal |
| `client/src/stores/` | Zustand state (workspace, editor, chat) |

### Agent event protocol

The client only understands harness events — it never talks to the model server
directly, so providers are swappable:

`message.delta` · `tool.started` · `tool.finished` · `approval.required` ·
`agent.finished` · `agent.error` · `terminal.output` · `file.changed`

## Safety model

- `read` tools: unrestricted inside the workspace root
- `write`/`edit`/`create` tools: require approval when auto-approve is off (UI shows the diff)
- `execute_command`: always requires approval unless explicitly auto-approved; a
  hard blocklist (`rm -rf /`, `sudo`, fork bombs, disk wipes, …) is never allowed
- All paths are resolved and validated against the workspace root — `../` escapes are rejected

## Development order (roadmap status)

- [x] React + Vite + TypeScript + Zustand
- [x] Monaco editor with tabs
- [x] Node API (workspace tree, file CRUD)
- [x] Provider adapter (OpenAI SDK, streaming)
- [x] Streaming chat over WebSocket
- [x] Agent loop + tool registry + tool calling
- [x] xterm.js terminal (real shell over WS)
- [x] Approval / permission layer + diff preview
- [x] Git tools (status/diff/log read-only)
- [ ] Plan-then-execute mode
- [ ] Embeddings/RAG context engine
- [ ] Git write operations behind permissions
