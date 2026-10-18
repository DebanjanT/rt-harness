/**
 * Text-format tool call parser.
 *
 * Many local models (and some serving setups) don't emit native OpenAI
 * `tool_calls` — instead they print tool calls in the message content using
 * XML-ish tags, code fences or raw JSON. This parser recovers structured tool
 * calls from that text so the agent loop still works.
 *
 * Supported formats (all tried in order):
 *   1. <tool.write_file>{"path":"a.txt","content":"…"}</tool.write_file>
 *      <tool NAME="write_file" path="a.txt">content…</tool>          (attr form)
 *   2. ```tool / ```tool_code / ```json fences:
 *      {"name": "write_file", "arguments": {"path": "…"}}
 *      or {"tool": "write_file", "args": {…}}
 *      or {"function": {"name": "…", "arguments": {…}}}   (OpenAI shape)
 *   3. Bare JSON object(s) containing a known tool name.
 */

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ParseResult {
  calls: ParsedToolCall[];
  /** Content with all recognized tool-call syntax removed. */
  cleanedText: string;
}

const FENCE_RE = /```(?:tool|tool_code|function_call|json)\s*\n((?:.|\n)*?)```/gi;
/** Any fenced block (used for function-call recovery inside plain fences). */
const ANY_FENCE_RE = /```[\w-]*\s*\n((?:.|\n)*?)```/g;
/** Function-call syntax: `write_file({…})` or `await write_file({…})`. */
const FN_CALL_RE = /(?:await\s+)?\b([A-Za-z_][\w.]*)\s*\(\s*(\{(?:[^{}]|\{[^{}]*\})*\})\s*\)/g;

function tryParseJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return parseLenientObject(t);
  }
}

/**
 * Lenient JSON-ish parsing for model output that is almost-JSON:
 * `// comments`, single-quoted strings, unquoted object keys.
 */
function parseLenientObject(text: string): unknown | undefined {
  let s = text.trim();
  if (!s.startsWith("{")) {
    const objStart = s.indexOf("{");
    const objEnd = s.lastIndexOf("}");
    if (objStart === -1 || objEnd <= objStart) return undefined;
    s = s.slice(objStart, objEnd + 1);
  }
  const sanitized = s
    .replace(/^\s*\/\/.*$/gm, "") // line comments
    .replace(/\\'/g, "'") // escaped single quotes
    .replace(/`([^`\\]*)`/g, '"$1"') // backtick template strings → quotes
    .replace(/'([^'\\]*)'/g, '"$1"') // single → double quotes
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":') // quote bare keys
    .replace(/,\s*([}\]])/g, "$1"); // trailing commas
  try {
    return JSON.parse(sanitized);
  } catch {
    // Models often wrap the args in a redundant outer block:
    //   { // comment
    //     { "path": … }   ← the actual args object
    //   }
    // Unwrap to the first inner object and retry.
    const innerStart = sanitized.indexOf("{");
    const innerEnd = sanitized.lastIndexOf("}");
    if (innerStart !== -1 && innerEnd > innerStart) {
      const inner = sanitized.slice(innerStart + 1, innerEnd).trim();
      if (inner.startsWith("{")) {
        try {
          return JSON.parse(inner);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
}

/** Extract first JSON object from a string (tolerating trailing prose). */
function extractJsonObject(text: string): unknown | undefined {
  return extractJsonObjectWithEnd(text)?.obj;
}

/** Same as extractJsonObject but also reports the index AFTER the object's `}`. */
function extractJsonObjectWithEnd(text: string): { obj: unknown; end: number } | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return { obj: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Normalize any of the accepted JSON shapes into {name, args}. */
function normalizeObject(obj: unknown): ParsedToolCall | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  // OpenAI complete shape: {type:"function", function:{name, arguments}}
  const fn = o.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === "string") {
    return { name: fn.name, args: parseArgs(fn.arguments) };
  }

  const name =
    (typeof o.name === "string" && o.name) ||
    (typeof o.tool === "string" && o.tool) ||
    (typeof o.tool_name === "string" && o.tool_name);
  if (!name) return null;

  const args =
    (o.arguments as Record<string, unknown>) ??
    (o.args as Record<string, unknown>) ??
    (o.parameters as Record<string, unknown>) ??
    (o.input as Record<string, unknown>) ??
    {};

  const merged: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [k, v] of Object.entries(o)) {
    if (["name", "tool", "tool_name", "arguments", "args", "parameters", "input", "type", "function"].includes(k)) continue;
    if (!(k in merged)) merged[k] = v;
  }
  return { name, args: merged };
}

/**
 * Models frequently put the target path under `file` / `filename` / `file_path`
 * instead of `path`. Lift it so write/edit tools receive what they expect.
 */
export function normalizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (!out.path) {
    for (const alt of ["file", "filename", "file_path", "file_name", "target"]) {
      if (typeof out[alt] === "string" && out[alt]) {
        out.path = out[alt];
        delete out[alt];
        break;
      }
    }
  }
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Fuzzy-match a parsed name to a known tool (case, dot-namespace, alias). */
function matchToolName(raw: string, known: Set<string>): string | null {
  const n = raw.toLowerCase().replace(/^.*\./, ""); // "tool.Node" -> "node"
  if (known.has(n)) return n;
  const aliases: Record<string, string> = {
    node: "write_file",
    write: "write_file",
    create_file: "write_file",
    new_file: "write_file",
    read: "read_file",
    cat: "read_file",
    edit: "edit_file",
    patch: "edit_file",
    search: "search_files",
    grep: "search_files",
    glob: "list_directory",
    ls: "list_directory",
    dir: "list_directory",
    bash: "execute_command",
    shell: "execute_command",
    run: "execute_command",
    terminal: "execute_command",
  };
  if (aliases[n] && known.has(aliases[n])) return aliases[n];
  for (const k of known) {
    if (k.toLowerCase() === n || k.toLowerCase().endsWith(n)) return k;
  }
  return null;
}

/**
 * Extract `key="value"` attributes from an opening tag string only
 * (returns {} when the tag has no real attributes).
 */
function tagAttrArgs(openTag: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const attrRe = /([A-Za-z_]\w*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(openTag)) !== null) {
    if (m[1] === "name") continue;
    args[m[1]] = m[2];
  }
  return args;
}

/**
 * Best-effort args from a non-JSON tag body. Recognizes `key="value"` /
 * `key: value` pairs; anything else becomes `content`.
 */
function bodyArgs(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const kvRe = /([A-Za-z_]\w*)\s*[=:]\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = kvRe.exec(body)) !== null) {
    args[m[1]] = m[2];
  }
  const rest = body.replace(kvRe, "").trim();
  if (rest && !("content" in args)) args.content = rest;
  else if (rest) args._extra = rest;
  return args;
}

/**
 * Parse assistant content into tool calls + cleaned prose.
 * Returns { calls: [], cleanedText: content } when nothing matches.
 */
export function parseTextToolCalls(content: string, knownTools: string[]): ParseResult {
  const calls: ParsedToolCall[] = [];
  let cleaned = content;
  const known = new Set(knownTools);

  // --- 1. <tool.NAME>…</tool.NAME>, <tool NAME="…">…</tool>, and the bare
  // <tool_call>…</tool_call> form (Qwen/Bonsai chat templates) -----------------
  // Opening tag allows extra attributes; closing tag allows the dotted form.
  // For the bare <tool_call> form the tool name comes from the JSON body.
  const tagRe = /<tool(?:_call|_calls|call)?(?:\s+name="([^"]*)"|\s*\.\s*([A-Za-z_][\w.]*))?[^>]*>((?:.|\n)*?)<\/tool[^>]*>/gi;
  cleaned = cleaned.replace(tagRe, (match, attrName, dotName, body) => {
    const rawName = (attrName ?? dotName ?? "") as string;
    const attrArgs = tagAttrArgs((match.match(/<tool[^>]*>/) ?? [""])[0]);
    const json = tryParseJson(body) ?? extractJsonObject(body);
    let tool = rawName ? matchToolName(rawName, known) : null;

    // Bare <tool_call>: the name lives inside the JSON body ("name" field).
    if (!tool && !rawName && json && typeof json === "object") {
      const norm = normalizeObject(json);
      if (norm && known.has(norm.name)) tool = norm.name;
    }
    if (!tool) return match; // keep unrecognized tags visible to the user

    let args: Record<string, unknown>;
    if (json && typeof json === "object") {
      const norm = normalizeObject(json);
      if (norm && norm.name === tool && !rawName) {
        // Bare form: the whole {name, arguments} object describes the call.
        args = norm.args;
      } else if (norm) {
        // Body was a full {name, arguments} / {tool, args} object.
        args = { ...attrArgs, ...norm.args };
      } else {
        // Body is a pure args object (no name field) — use it directly.
        args = { ...attrArgs };
        for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
          if (!"type function name tool tool_name".split(" ").includes(k)) args[k] = v;
        }
      }
    } else {
      args = { ...attrArgs, ...bodyArgs(body) };
    }
    calls.push({ name: tool, args });
    return ""; // strip recognized tool-call syntax from displayed text
  });

  // --- 1b. stray fragments from degenerate outputs ----------------------------
  // e.g. "</tool_call>I cannot proceed…" or a lone "<tool_call>" — never
  // meaningful prose, always chat-template noise. Strip from display text.
  cleaned = cleaned.replace(/<\/?(?:tool_call|toolcalls?|tool)>/gi, "");

  // --- 1c. UNCLOSED tool tags -------------------------------------------------
  // Models often emit `<tool.write_file> { … }` and forget the closing tag.
  // Only tried when no closed tags matched, and only when the open tag has no
  // `</tool` anywhere after it.
  if (calls.length === 0) {
    const openRe = /<tool(?:\s+name="([^"]*)"|\s*\.\s*([A-Za-z_][\w.]*))?[^>]*>((?:.|\n)+)/gi;
    let om: RegExpExecArray | null;
    while ((om = openRe.exec(content)) !== null) {
      const afterOpen = content.slice(om.index + 1);
      if (afterOpen.toLowerCase().includes("</tool")) continue; // closed elsewhere
      const rawName = (om[1] ?? om[2] ?? "") as string;
      const tool = matchToolName(rawName, known);
      if (!tool) continue;
      const body = om[3];
      const attrArgs = tagAttrArgs(om[0].slice(0, om[0].indexOf(">") + 1));
      const json = tryParseJson(body) ?? extractJsonObject(body);
      let args: Record<string, unknown>;
      if (json && typeof json === "object") {
        const norm = normalizeObject(json);
        args = { ...attrArgs, ...(norm ? norm.args : (json as Record<string, unknown>)) };
        for (const k of ["type", "function", "name", "tool", "tool_name"]) delete args[k];
      } else {
        args = { ...attrArgs, ...bodyArgs(body) };
      }
      calls.push({ name: tool, args });
      cleaned = cleaned.replace(om[0], "").trim();
      break;
    }
  }

  // --- 2. fenced blocks -------------------------------------------------------
  cleaned = cleaned.replace(FENCE_RE, (match, body: string) => {
    const json = tryParseJson(body) ?? extractJsonObject(body);
    if (!json) return match;
    const arr = Array.isArray(json) ? json : [json];
    let matched = false;
    for (const item of arr) {
      const norm = normalizeObject(item);
      if (norm && known.has(norm.name)) {
        calls.push(norm);
        matched = true;
      }
    }
    return matched ? "" : match;
  });

  // --- 2b. function-call syntax in ANY fence or prose --------------------------
  // e.g. ```\nawait write_file({ "path": "a.txt", content: "hi" })\n```
  // Models frequently emit pseudo-code like this instead of real tool calls.
  if (calls.length === 0) {
    const scan = (segment: string, strip: (s: string) => string) => {
      FN_CALL_RE.lastIndex = 0;
      let fm: RegExpExecArray | null;
      while ((fm = FN_CALL_RE.exec(segment)) !== null) {
        const tool = matchToolName(fm[1], known);
        if (!tool) continue;
        const json = tryParseJson(fm[2]) ?? parseLenientObject(fm[2]);
        if (json && typeof json === "object") {
          calls.push({ name: tool, args: json as Record<string, unknown> });
        }
      }
      if (calls.length > 0) cleaned = strip(cleaned);
    };

    // Inside fences first (most common), stripping the whole fence on match.
    cleaned = cleaned.replace(ANY_FENCE_RE, (fence, body: string) => {
      if (calls.length > 0) return fence;
      FN_CALL_RE.lastIndex = 0;
      let fm: RegExpExecArray | null;
      let fenceMatched = false;
      while ((fm = FN_CALL_RE.exec(body)) !== null) {
        const tool = matchToolName(fm[1], known);
        if (!tool) continue;
        const json = tryParseJson(fm[2]) ?? parseLenientObject(fm[2]);
        if (json && typeof json === "object") {
          calls.push({ name: tool, args: json as Record<string, unknown> });
          fenceMatched = true;
        }
      }
      return fenceMatched ? "" : fence;
    });

    // Then bare prose like: await write_file({"path": …}) outside fences.
    if (calls.length === 0) {
      FN_CALL_RE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      const found: string[] = [];
      while ((pm = FN_CALL_RE.exec(content)) !== null) {
        const tool = matchToolName(pm[1], known);
        if (!tool) continue;
        const json = tryParseJson(pm[2]) ?? parseLenientObject(pm[2]);
        if (json && typeof json === "object") {
          calls.push({ name: tool, args: json as Record<string, unknown> });
          found.push(pm[0]);
        }
      }
      if (calls.length > 0) {
        cleaned = cleaned.replace(FN_CALL_RE, (s) => (found.includes(s) ? "" : s));
      }
    }
  }

  // --- 3. bare JSON objects with a known tool name ----------------------------
  // Uses the string-aware brace scanner (not a regex) so objects whose string
  // values contain braces — e.g. C code in write_file content — parse correctly
  // at any nesting depth.
  if (calls.length === 0) {
    const candidates: string[] = [];
    let i = 0;
    while (i < content.length) {
      if (content[i] !== "{") {
        i++;
        continue;
      }
      const found = extractJsonObjectWithEnd(content.slice(i));
      if (!found) {
        i++;
        continue;
      }
      const raw = content.slice(i, i + found.end);
      const norm = normalizeObject(found.obj);
      if (norm && known.has(norm.name)) {
        calls.push(norm);
        candidates.push(raw);
      }
      i += Math.max(found.end, 1);
    }
    if (calls.length > 0) {
      for (const raw of candidates) {
        cleaned = cleaned.replace(raw, "");
      }
    }
  }

  // --- 4. known-tool single-key shape: {"write_file": {"path": …}} ------------
  if (calls.length === 0) {
    for (const tool of known) {
      const re = new RegExp(`\\{\\s*"${tool}"\\s*:\\s*(\\{(?:[^{}]|\\{[^{}]*\\})*\\})`, "g");
      cleaned = cleaned.replace(re, (_s, argsJson: string) => {
        calls.push({ name: tool, args: parseArgs(argsJson) });
        return "";
      });
      if (calls.length) break;
    }
  }

  return { calls: withNormalizedArgs(calls), cleanedText: cleaned.trim() };
}

/** Post-pass: lift file/filename keys onto `path` for every parsed call. */
export function withNormalizedArgs(calls: ParsedToolCall[]): ParsedToolCall[] {
  return calls.map((c) => ({ ...c, args: normalizeToolArgs(c.args) }));
}
