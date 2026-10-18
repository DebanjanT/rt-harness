import type { FileNode, ProviderInfo } from "../types/agent";

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
};
