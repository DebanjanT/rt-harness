export { resolveInWorkspace } from "../workspace/FileSystem.js";

/** Extensions the editor/agent treats as text. Binary blobs are refused. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".tar", ".rar", ".7z", ".exe", ".dll", ".so", ".dylib", ".bin", ".woff",
  ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi", ".wasm",
  ".pyc", ".class", ".o", ".a", ".sqlite", ".db",
]);

export function isBinaryPath(p: string): boolean {
  return BINARY_EXT.has(p.slice(p.lastIndexOf(".")).toLowerCase());
}

/** Heuristic binary sniff for extensionless files. */
export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  for (const b of sample) if (b === 0) return true;
  return false;
}
