import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { api, setWorkspaceChangedHook } from "./api/files.js";
import { AgentSession } from "./ws/AgentSession.js";
import { TerminalManager } from "./ws/TerminalManager.js";
import { getConfig } from "./config.js";
import type { AgentEvent, ClientMessage } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/api", api);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspaceRoot: getConfig().workspaceRoot });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Live terminal managers — restarted when the workspace root changes.
const terminals = new Set<TerminalManager>();

// When the workspace root changes, tell every connected client to reload its
// explorer + restart its terminal in the new root.
setWorkspaceChangedHook(() => {
  for (const t of terminals) t.dispose(); // next input re-spawns in the new root
  const event: AgentEvent = { type: "file.changed", path: "*" };
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
  }
  console.log("[ws] broadcast workspace change");
});

wss.on("connection", (ws: WebSocket) => {
  const session = new AgentSession(ws);
  const terminal = new TerminalManager(ws);
  terminals.add(terminal);
  console.log("[ws] client connected");

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "terminal.input") terminal.input(msg.data);
    else if (msg.type === "terminal.resize") terminal.resize(msg.cols, msg.rows);
    else if (msg.type === "terminal.start") terminal.start();
    else void session.handle(msg);
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    terminals.delete(terminal);
    session.dispose();
    terminal.dispose();
  });
});

server.listen(PORT, () => {
  console.log(`\n  rt-harness agent server`);
  console.log(`  ├─ API:      http://localhost:${PORT}/api`);
  console.log(`  ├─ WS:       ws://localhost:${PORT}/ws`);
  console.log(`  └─ Workspace: ${getConfig().workspaceRoot}\n`);
});
