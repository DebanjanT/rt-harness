import crypto from "node:crypto";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// better-sqlite3 is a native CJS module — the server is ESM.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// src/chat/ → server/ → project root → data/
const DB_PATH = path.resolve(__dirname, "../../../data/harness.db");

export interface ChatSummary {
  id: string;
  workspace: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredChat extends ChatSummary {
  /** OpenAI-format message history (minus the system prompt). */
  history: unknown[];
  /** Client display timeline (ChatEntry[] JSON) for full UI fidelity. */
  entries: unknown[];
}

let db: import("better-sqlite3").Database | null = null;

function getDb(): import("better-sqlite3").Database {
  if (db) return db;
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      title TEXT NOT NULL,
      history TEXT NOT NULL DEFAULT '[]',
      display TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db = d;
  return d;
}

function toSummary(row: { id: string; workspace: string; title: string; created_at: number; updated_at: number }): ChatSummary {
  return {
    id: row.id,
    workspace: row.workspace,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** List chats for a workspace, newest activity first. */
export function listChats(workspace: string): ChatSummary[] {
  const rows = getDb()
    .prepare("SELECT * FROM chats WHERE workspace = ? ORDER BY updated_at DESC LIMIT 100")
    .all(workspace) as { id: string; workspace: string; title: string; created_at: number; updated_at: number }[];
  return rows.map(toSummary);
}

export function createChat(workspace: string, title: string): ChatSummary {
  const chat: ChatSummary = {
    id: crypto.randomUUID(),
    workspace,
    title: title.slice(0, 80) || "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  getDb()
    .prepare("INSERT INTO chats (id, workspace, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(chat.id, chat.workspace, chat.title, chat.createdAt, chat.updatedAt);
  return chat;
}

export function getChat(id: string): StoredChat | null {
  const row = getDb().prepare("SELECT * FROM chats WHERE id = ?").get(id) as
    | { id: string; workspace: string; title: string; history: string; display: string; created_at: number; updated_at: number }
    | undefined;
  if (!row) return null;
  const parse = (s: string, fallback: unknown[]) => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };
  return {
    ...toSummary(row),
    history: parse(row.history, []),
    entries: parse(row.display, []),
  };
}

/** Persist history and/or display entries; bumps updated_at. */
export function saveChat(
  id: string,
  patch: { history?: unknown[]; entries?: unknown[]; title?: string },
): boolean {
  const existing = getDb().prepare("SELECT id FROM chats WHERE id = ?").get(id);
  if (!existing) return false;
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [Date.now()];
  if (patch.history !== undefined) {
    sets.push("history = ?");
    vals.push(JSON.stringify(patch.history));
  }
  if (patch.entries !== undefined) {
    sets.push("display = ?");
    vals.push(JSON.stringify(patch.entries));
  }
  if (patch.title !== undefined) {
    sets.push("title = ?");
    vals.push(patch.title.slice(0, 80));
  }
  vals.push(id);
  getDb().prepare(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteChat(id: string): boolean {
  const r = getDb().prepare("DELETE FROM chats WHERE id = ?").run(id);
  return r.changes > 0;
}
