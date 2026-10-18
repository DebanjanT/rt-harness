import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { api } from "./api/files.js";
import { AgentSession } from "./ws/AgentSession.js";
import { TerminalManager } from "./ws/TerminalManager.js";
import { getConfig } from "./config.js";
import type { ClientMessage } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/api", api);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspaceRoot: getConfig().workspaceRoot });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  const session = new AgentSession(ws);
  const terminal = new TerminalManager(ws);
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
