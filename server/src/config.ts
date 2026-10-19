import fsSync from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import type { HarnessConfig } from "./types.js";

const require = createRequire(import.meta.url);
// better-sqlite3 is a native CJS module — the server is ESM.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * SQLite-backed config store.
 *
 * Replaces the dual harness.config.json / server/harness.local.json files:
 * one DB at server/data/harness.db holds the SAME keys, so nothing else in
 * the codebase changes. On first run it MIGRATES values from the legacy JSON
 * files (local overrides win, then committed defaults). The DB is the single
 * source of truth afterwards; JSON files are left untouched as backup.
 */

const DB_PATH = path.resolve(__dirname, "../../data/harness.db");

interface StoredConfig extends HarnessConfig {
  recentWorkspaces?: string[];
}

export type ProviderEntry = HarnessConfig["providers"][number];

/** Factory-reset values for the agent settings dialog. */
export const AGENT_DEFAULTS = {
  maxIterations: 25,
  maxFileReadChars: 60000,
  maxSearchResults: 50,
  maxOutputTokens: 4096,
} as const;

let cfg: StoredConfig & HarnessConfig = defaultConfig();

function defaultConfig(): StoredConfig & HarnessConfig {
  return {
    workspaceRoot: process.env.HARNESS_WORKSPACE ?? process.cwd(),
    providers: [
      {
        id: "ollama",
        name: "Ollama (local)",
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        models: [],
      },
      {
        id: "freetoken",
        name: "FreeToken (local)",
        baseURL: process.env.FREETOKEN_BASE_URL ?? "http://127.0.0.1:1919/v1",
        apiKey: "freetoken",
        models: [],
      },
      {
        id: "mlx",
        name: "MLX-LM (Apple Silicon)",
        baseURL: process.env.MLX_BASE_URL ?? "http://127.0.0.1:8080/v1",
        apiKey: "mlx",
        models: [],
      },
    ],
    agent: {
      maxIterations: 25,
      maxFileReadChars: 60000,
      maxSearchResults: 50,
      maxOutputTokens: 4096,
    },
    recentWorkspaces: [],
  };
}

function migrateFromJson(db: import("better-sqlite3").Database): void {
  // Look for legacy JSON config, nearest-cwd-first like the old loader.
  const candidates = [
    path.resolve(process.cwd(), "harness.local.json"),
    path.resolve(process.cwd(), "harness.config.json"),
    path.resolve(__dirname, "../../harness.local.json"),
    path.resolve(__dirname, "../../harness.config.json"),
    path.resolve(__dirname, "../../server/harness.local.json"),
  ];
  for (const file of candidates) {
    try {
      if (!fsSync.existsSync(file)) continue;
      const loaded = JSON.parse(fsSync.readFileSync(file, "utf8")) as Partial<
        StoredConfig & HarnessConfig
      >;
      const defaults = defaultConfig();
      cfg = {
        ...defaults,
        ...loaded,
        agent: { ...defaults.agent, ...(loaded.agent ?? {}) },
        providers: loaded.providers?.length ? loaded.providers : defaults.providers,
        recentWorkspaces: loaded.recentWorkspaces ?? [],
      };
      console.log(`[config] migrated settings from ${file} into SQLite`);
      return;
    } catch {
      /* try next candidate */
    }
  }
  cfg = defaultConfig();
  console.log("[config] no legacy JSON found — starting with defaults");
}

function initDb(): import("better-sqlite3").Database {
  fsSync.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db: import("better-sqlite3").Database = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function loadFromDb(db: import("better-sqlite3").Database): (StoredConfig & HarnessConfig) | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'config'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as StoredConfig & HarnessConfig;
    const defaults = defaultConfig();
    return {
      ...defaults,
      ...parsed,
      agent: { ...defaults.agent, ...(parsed.agent ?? {}) },
      providers: parsed.providers?.length ? parsed.providers : defaults.providers,
      recentWorkspaces: parsed.recentWorkspaces ?? [],
    };
  } catch (err) {
    console.warn("[config] DB config corrupt — re-migrating:", err);
    return null;
  }
}

function saveToDb(db: import("better-sqlite3").Database, config: StoredConfig): void {
  db.prepare(
    "INSERT INTO kv (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(config, null, 2));
}

// ---- init -----------------------------------------------------------------
const db = initDb();
{
  const loaded = loadFromDb(db);
  if (loaded) {
    cfg = loaded;
  } else {
    migrateFromJson(db);
    saveToDb(db, cfg); // persist the migrated values immediately
  }
}

// Resolve workspaceRoot relative to the DB location if it isn't absolute.
if (!path.isAbsolute(cfg.workspaceRoot)) {
  cfg.workspaceRoot = path.resolve(__dirname, "../../", cfg.workspaceRoot);
}

// ---- public API (same shape as the old config.ts) --------------------------

export function getConfig(): StoredConfig & HarnessConfig {
  return cfg;
}

export function getProvider(id: string) {
  return cfg.providers.find((p: ProviderEntry) => p.id === id);
}

function persist(): void {
  saveToDb(db, cfg);
}

export function addProvider(p: ProviderEntry): boolean {
  if (cfg.providers.some((x: ProviderEntry) => x.id === p.id)) return false;
  cfg.providers.push(p);
  persist();
  return true;
}

export function removeProvider(id: string): boolean {
  const before = cfg.providers.length;
  cfg.providers = cfg.providers.filter((p: ProviderEntry) => p.id !== id);
  if (cfg.providers.length !== before) {
    persist();
    return true;
  }
  return false;
}

export function touchRecentWorkspace(absPath: string): void {
  const list = (cfg.recentWorkspaces ?? []).filter((p: string) => p !== absPath);
  list.unshift(absPath);
  cfg.recentWorkspaces = list.slice(0, 8);
  persist();
}

export function setWorkspaceRoot(absPath: string): string {
  const resolved = path.resolve(absPath);
  const stat = fsSync.statSync(resolved); // throws if missing
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  cfg.workspaceRoot = resolved;
  touchRecentWorkspace(resolved);
  console.log(`[config] workspace switched to ${resolved}`);
  return resolved;
}

/** Update agent settings from the UI (validated numeric patch). */
export function updateAgentSettings(
  patch: Partial<HarnessConfig["agent"]>,
): HarnessConfig["agent"] {
  const clamp = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
  };
  if (patch.maxIterations !== undefined)
    cfg.agent.maxIterations = clamp(patch.maxIterations, 1, 100, AGENT_DEFAULTS.maxIterations);
  if (patch.maxFileReadChars !== undefined)
    cfg.agent.maxFileReadChars = clamp(patch.maxFileReadChars, 1000, 500_000, AGENT_DEFAULTS.maxFileReadChars);
  if (patch.maxSearchResults !== undefined)
    cfg.agent.maxSearchResults = clamp(patch.maxSearchResults, 1, 200, AGENT_DEFAULTS.maxSearchResults);
  if (patch.maxOutputTokens !== undefined)
    cfg.agent.maxOutputTokens = clamp(patch.maxOutputTokens, 256, 65_536, AGENT_DEFAULTS.maxOutputTokens);
  persist();
  console.log("[config] agent settings updated:", cfg.agent);
  return { ...cfg.agent };
}

/** Factory provider entries captured at module load — for the reset button. */
const FACTORY_PROVIDERS: ProviderEntry[] = defaultConfig().providers;

/**
 * Update a provider (e.g. the user moved their Ollama/MLX server to a
 * different port). Persisted to SQLite, so the harness keeps pulling the
 * new URL from there across restarts.
 */
export function updateProvider(
  id: string,
  patch: { baseURL?: string; name?: string; apiKey?: string },
): ProviderEntry {
  const p = cfg.providers.find((x: ProviderEntry) => x.id === id);
  if (!p) throw new Error(`provider not found: ${id}`);
  if (patch.baseURL !== undefined) {
    const url = patch.baseURL.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(url)) throw new Error("baseURL must be a valid http(s) URL");
    p.baseURL = url;
  }
  if (patch.name !== undefined && patch.name.trim()) p.name = patch.name.trim().slice(0, 60);
  if (patch.apiKey !== undefined && patch.apiKey.trim()) p.apiKey = patch.apiKey.trim();
  p.models = []; // force re-discovery against the new URL
  persist();
  console.log(`[config] provider "${id}" updated → ${p.baseURL}`);
  return p;
}

/**
 * Restore a built-in provider's factory baseURL/env override. Returns null
 * for custom providers (they have no factory default — delete instead).
 */
export function resetProvider(id: string): ProviderEntry | null {
  const idx = cfg.providers.findIndex((x: ProviderEntry) => x.id === id);
  if (idx === -1) throw new Error(`provider not found: ${id}`);
  const factory = FACTORY_PROVIDERS.find((x) => x.id === id);
  if (!factory) return null;
  cfg.providers[idx] = { ...factory, models: [] };
  persist();
  console.log(`[config] provider "${id}" reset to factory URL ${factory.baseURL}`);
  return cfg.providers[idx];
}

/** Factory baseURL for a provider id (null = custom provider, no default). */
export function getFactoryBaseURL(id: string): string | null {
  return FACTORY_PROVIDERS.find((x) => x.id === id)?.baseURL ?? null;
}
