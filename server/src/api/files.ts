import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../config.js";
import { getTree, resolveInWorkspace, pathExists } from "../workspace/FileSystem.js";
import { isBinaryPath, looksBinary } from "../security/PathPolicy.js";
import { listModels } from "../llm/provider.js";

export const api = Router();

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
