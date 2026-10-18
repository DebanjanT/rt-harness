import type { FileNode, ProviderInfo, ModelCapabilities } from "../types/agent";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getTree: () =>
    fetch("/api/workspace/tree")
      .then((r) => json<{ root: string; tree: FileNode[] }>(r)),

  getFile: (path: string) =>
    fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; content: string }>(r),
    ),

  saveFile: (path: string, content: string) =>
    fetch("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    }).then((r) => json<{ ok: boolean }>(r)),

  createFolder: (path: string) =>
    fetch("/api/folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ ok: boolean }>(r)),

  deleteFile: (path: string) =>
    fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),

  getProviders: () =>
    fetch("/api/providers").then((r) =>
      json<{ providers: ProviderInfo[]; workspaceRoot: string }>(r),
    ),

  /** Add a custom/cloud OpenAI-compatible endpoint. The server verifies it. */
  addProvider: (name: string, baseURL: string, apiKey: string) =>
    fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, baseURL, apiKey }),
    }).then((r) => json<{ ok: boolean; provider: ProviderInfo }>(r)),

  removeProvider: (id: string) =>
    fetch(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),

  /** Probe a model for tool/vision support (cached server-side). */
  getCapabilities: (providerId: string, model: string) =>
    fetch(`/api/capabilities?providerId=${encodeURIComponent(providerId)}&model=${encodeURIComponent(model)}`).then(
      (r) => json<ModelCapabilities>(r),
    ),

  // -- workspace management --

  getWorkspaceInfo: () =>
    fetch("/api/workspace").then((r) =>
      json<{
        current: { path: string; name: string };
        recents: { path: string; name: string; exists: boolean; isCurrent: boolean }[];
        home: string;
      }>(r),
    ),

  selectWorkspace: (path: string) =>
    fetch("/api/workspace/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ ok: boolean; workspaceRoot: string }>(r)),

  createWorkspace: (path: string) =>
    fetch("/api/workspace/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ ok: boolean; workspaceRoot: string }>(r)),

  /** Browse directories (for the picker's folder browser). */
  listDirs: (dir: string) =>
    fetch(`/api/workspace/list?dir=${encodeURIComponent(dir)}`).then((r) =>
      json<{ dir: string; parent: string; entries: { name: string; path: string }[]; current: string }>(r),
    ),
};
