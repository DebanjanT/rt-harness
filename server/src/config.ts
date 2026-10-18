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
