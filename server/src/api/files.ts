import { Router } from "express";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getConfig, addProvider, removeProvider, setWorkspaceRoot } from "../config.js";
import { getTree, resolveInWorkspace, pathExists } from "../workspace/FileSystem.js";
import { isBinaryPath, looksBinary } from "../security/PathPolicy.js";
import { listModels, createLLM } from "../llm/provider.js";
import type { ProviderConfig } from "../types.js";

export const api = Router();

/** Set by index.ts — notifies all WS clients to reload after a workspace switch. */
export let onWorkspaceChanged: () => void = () => {};
export function setWorkspaceChangedHook(fn: () => void) {
  onWorkspaceChanged = fn;
}

/** GET /api/workspace/tree — full pruned tree for the Explorer. */
api.get("/workspace/tree", async (_req, res) => {
  res.json({ root: getConfig().workspaceRoot, tree: await getTree() });
});

/** GET /api/file?path=src/App.tsx */
api.get("/file", async (req, res) => {
  try {
    const rel = String(req.query.path ?? "");
    if (!rel) return res.status(400).json({ error: "path query param required" });
    const abs = resolveInWorkspace(rel);
    if (!(await pathExists(abs))) return res.status(404).json({ error: "not found" });
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return res.status(400).json({ error: "not a file" });
    if (isBinaryPath(rel)) {
      return res.status(415).json({ error: "binary file" });
    }
    const content = await fs.readFile(abs, "utf8");
    if (looksBinary(Buffer.from(content.slice(0, 8000), "utf8"))) {
      return res.status(415).json({ error: "binary file" });
    }
    res.json({ path: rel, content });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** POST /api/file { path, content } — direct editor saves (user-driven). */
api.post("/file", async (req, res) => {
  try {
    const { path: rel, content } = req.body as { path?: string; content?: string };
    if (!rel || typeof content !== "string") {
      return res.status(400).json({ error: "path and content required" });
    }
    if (isBinaryPath(rel)) return res.status(415).json({ error: "binary file" });
    const abs = resolveInWorkspace(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    res.json({ ok: true, path: rel });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** POST /api/folder { path } */
api.post("/folder", async (req, res) => {
  try {
    const { path: rel } = req.body as { path?: string };
    if (!rel) return res.status(400).json({ error: "path required" });
    await fs.mkdir(resolveInWorkspace(rel), { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** DELETE /api/file?path=... */
api.delete("/file", async (req, res) => {
  try {
    const rel = String(req.query.path ?? "");
    const abs = resolveInWorkspace(rel);
    await fs.rm(abs, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** GET /api/providers — providers with live model discovery. */
api.get("/providers", async (_req, res) => {
  const cfg = getConfig();
  const providers = await Promise.all(
    cfg.providers.map(async (p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      models: await listModels(p),
    })),
  );
  res.json({ providers, workspaceRoot: cfg.workspaceRoot });
});

/** POST /api/providers — add a custom/cloud OpenAI-compatible endpoint. */
api.post("/providers", async (req, res) => {
  const { name, baseURL, apiKey } = req.body as {
    name?: string;
    baseURL?: string;
    apiKey?: string;
  };
  if (!baseURL || !/^https?:\/\//.test(baseURL)) {
    return res.status(400).json({ error: "baseURL must be a valid http(s) URL ending in /v1" });
  }
  const normalized = baseURL.replace(/\/+$/, "");
  const id = `custom_${crypto.randomUUID().slice(0, 8)}`;

  const provider = {
    id,
    name: name?.trim() || normalized.replace(/^https?:\/\//, "").slice(0, 40),
    baseURL: normalized,
    apiKey: apiKey || "not-needed",
    models: [] as string[],
  };

  // Verify the endpoint actually responds before saving. listModels() swallows
  // errors by design (boot-time discovery), so probe the endpoint directly here.
  try {
    const probe = await fetch(`${normalized}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!probe.ok) {
      return res.status(502).json({
        error: `Endpoint responded ${probe.status} ${probe.statusText} for ${normalized}/models. Check the URL and API key.`,
      });
    }
    const body = (await probe.json()) as { data?: { id?: string }[] };
    provider.models = (body.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => Boolean(x))
      .sort();
  } catch (err) {
    return res.status(502).json({
      error: `Could not reach ${normalized}/models — ${(err as Error).message}. Check the URL/key and that it exposes an OpenAI-compatible /v1 API.`,
    });
  }

  if (!addProvider(provider)) {
    return res.status(409).json({ error: "provider id collision — try again" });
  }
  console.log(`[providers] added custom provider "${provider.name}" → ${provider.baseURL} (${provider.models.length} models)`);
  res.json({ ok: true, provider });
});

/** DELETE /api/providers/:id */
api.delete("/providers/:id", (req, res) => {
  if (removeProvider(req.params.id)) return res.json({ ok: true });
  res.status(404).json({ error: "provider not found" });
});

// ---------------------------------------------------------------------------
// Model capability probing (tools / vision) with caching
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  /** Human-readable detail when a capability is missing. */
  notes: string[];
}

// 1x1 red PNG
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const capCache = new Map<string, ModelCapabilities>();

export function probeCapabilities(baseURL: string, apiKey: string, model: string): Promise<ModelCapabilities> {
  const key = `${baseURL}::${model}`;
  const cached = capCache.get(key);
  if (cached) return Promise.resolve(cached);

  const client = createLLM({ id: "probe", name: "probe", baseURL, apiKey });
  const notes: string[] = [];
  const caps: ModelCapabilities = { tools: true, vision: true, notes: [] };

  const probeTools = client.chat.completions
    .create({
      model,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "noop", description: "Do nothing.", parameters: { type: "object", properties: {} } },
        },
      ],
      max_tokens: 5,
      stream: false,
    })
    .then(() => {})
    .catch((err: Error) => {
      if (/tool|function/i.test(err.message)) {
        caps.tools = false;
        notes.push("Model/server does not support native tool calling — the harness will fall back to text-mode tool calls.");
      }
      // Other errors (rate limit, auth, context) don't prove tools are unsupported.
    });

  const probeVision = client.chat.completions
    .create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: TINY_PNG } },
          ],
        },
      ],
      max_tokens: 5,
      stream: false,
    })
    .then(() => {})
    .catch((err: Error) => {
      if (/image|vision|multimodal|content/i.test(err.message)) {
        caps.vision = false;
        notes.push("Model does not accept image input (no vision support).");
      }
    });

  return Promise.all([probeTools, probeVision]).then(() => {
    caps.notes = notes;
    capCache.set(key, caps);
    return caps;
  });
}

/** GET /api/capabilities?providerId=…&model=… — probe tools/vision support. */
api.get("/capabilities", async (req, res) => {
  const providerId = String(req.query.providerId ?? "");
  const model = String(req.query.model ?? "");
  const provider = getConfig().providers.find((p) => p.id === providerId);
  if (!provider) return res.status(404).json({ error: "unknown provider" });
  if (!model) return res.status(400).json({ error: "model query param required" });
  try {
    const caps = await probeCapabilities(provider.baseURL, provider.apiKey ?? "not-needed", model);
    res.json(caps);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Workspace management (picker modal: current, recents, switch, create)
// ---------------------------------------------------------------------------

/** GET /api/workspace — current root + recent workspaces (with existence check). */
api.get("/workspace", (_req, res) => {
  const cfg = getConfig();
  const recents = (cfg.recentWorkspaces ?? []).map((p) => ({
    path: p,
    name: path.basename(p),
    exists: fsSync.existsSync(p),
    isCurrent: p === cfg.workspaceRoot,
  }));
  res.json({
    current: { path: cfg.workspaceRoot, name: path.basename(cfg.workspaceRoot) },
    recents,
    home: os.homedir(),
  });
});

/** POST /api/workspace/select { path } — switch to an existing directory. */
api.post("/workspace/select", (req, res) => {
  try {
    const { path: target } = req.body as { path?: string };
    if (!target) return res.status(400).json({ error: "path required" });
    const resolved = setWorkspaceRoot(target);
    onWorkspaceChanged();
    res.json({ ok: true, workspaceRoot: resolved });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** POST /api/workspace/create { path } — mkdir -p and switch to it. */
api.post("/workspace/create", (req, res) => {
  try {
    const { path: target } = req.body as { path?: string };
    if (!target) return res.status(400).json({ error: "path required" });
    const resolved = path.resolve(target);
    if (fsSync.existsSync(resolved)) {
      if (!fsSync.statSync(resolved).isDirectory()) {
        return res.status(400).json({ error: `${resolved} exists and is not a directory` });
      }
    } else {
      fsSync.mkdirSync(resolved, { recursive: true });
    }
    const root = setWorkspaceRoot(resolved);
    onWorkspaceChanged();
    res.json({ ok: true, workspaceRoot: root });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** GET /api/workspace/list?dir=… — browse directories for the picker. */
api.get("/workspace/list", (req, res) => {
  try {
    const cfg = getConfig();
    const dir = path.resolve(String(req.query.dir ?? "") || os.homedir());
    const entries = fsSync
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ dir, parent: path.dirname(dir), entries, current: cfg.workspaceRoot });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
