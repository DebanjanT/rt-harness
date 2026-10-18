import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import type { HarnessConfig } from "./types.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * Config resolution order:
 *   1. harness.local.json (gitignored — your personal overrides)
 *   2. harness.config.json (committed defaults)
 *   3. built-in defaults
 */
const candidates = [
  path.resolve(process.cwd(), "harness.local.json"),
  path.resolve(process.cwd(), "harness.config.json"),
  path.resolve(__dirname, "../../harness.local.json"),
  path.resolve(__dirname, "../../harness.config.json"),
];

const defaults: HarnessConfig = {
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
      baseURL: process.env.MLX_BASE_URL ?? "http://127.0.0.1:8000/v1",
      apiKey: "mlx",
      models: [],
    },
  ],
  agent: {
    maxIterations: 25,
    maxFileReadChars: 60000,
    maxSearchResults: 50,
  },
};

let cfg: HarnessConfig = defaults;

for (const file of candidates) {
  try {
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HarnessConfig>;
      cfg = {
        ...defaults,
        ...loaded,
        agent: { ...defaults.agent, ...(loaded.agent ?? {}) },
        providers: loaded.providers?.length ? loaded.providers : defaults.providers,
      };
      console.log(`[config] loaded ${path.basename(file)}`);
      break;
    }
  } catch (err) {
    console.warn(`[config] failed to load ${file}:`, err);
  }
}

// Resolve workspaceRoot to an absolute path relative to the config file's dir.
if (!path.isAbsolute(cfg.workspaceRoot)) {
  const base = candidates.find((f) => fs.existsSync(f)) ?? process.cwd();
  cfg.workspaceRoot = path.resolve(path.dirname(base), cfg.workspaceRoot);
}

export function getConfig(): HarnessConfig {
  return cfg;
}

export function getProvider(id: string) {
  return cfg.providers.find((p) => p.id === id);
}

/**
 * Persist the CURRENT config to harness.local.json (gitignored). Used when the
 * user adds/removes a custom provider at runtime so it survives restarts.
 */
function persistLocal(): void {
  const localPath = path.resolve(process.cwd(), "harness.local.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(localPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* start fresh */
  }
  existing.providers = cfg.providers;
  existing.workspaceRoot = cfg.workspaceRoot;
  existing.agent = cfg.agent;
  existing.recentWorkspaces = cfg.recentWorkspaces ?? [];
  try {
    fs.writeFileSync(localPath, JSON.stringify(existing, null, 2));
  } catch (err) {
    console.warn("[config] could not persist harness.local.json:", err);
  }
}

/** Add a runtime (custom/cloud) provider. Returns false if id collides. */
export function addProvider(p: HarnessConfig["providers"][number]): boolean {
  if (cfg.providers.some((x) => x.id === p.id)) return false;
  cfg.providers.push(p);
  persistLocal();
  return true;
}

/** Remove a provider by id. */
export function removeProvider(id: string): boolean {
  const before = cfg.providers.length;
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  if (cfg.providers.length !== before) {
    persistLocal();
    return true;
  }
  return false;
}

/** Remember a workspace root in the recents list (most recent first, deduped). */
export function touchRecentWorkspace(absPath: string): void {
  const list = (cfg.recentWorkspaces ?? []).filter((p) => p !== absPath);
  list.unshift(absPath);
  cfg.recentWorkspaces = list.slice(0, 8);
  persistLocal();
}

/**
 * Switch the active workspace root. Validates the directory exists and
 * records it in recents. Returns the resolved absolute path.
 */
export function setWorkspaceRoot(absPath: string): string {
  const resolved = path.resolve(absPath);
  const stat = fs.statSync(resolved); // throws if missing
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  cfg.workspaceRoot = resolved;
  touchRecentWorkspace(resolved);
  console.log(`[config] workspace switched to ${resolved}`);
  return resolved;
}
