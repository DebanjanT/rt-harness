import type { Tool } from "./ToolRegistry.js";

/**
 * Web access tools — harness-based (works with ANY model, no provider
 * capability needed): web_search (DuckDuckGo HTML results) + fetch_url
 * (retrieve a page as plain text for the model to read).
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(ms),
    redirect: "follow",
  });
}

/** Strip HTML to readable text (no deps: tag removal + entity decode). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeDuckEntity(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
}

/** DuckDuckGo HTML endpoint — no API key required. */
async function webSearch(query: string, maxResults: number): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, 15000);
  if (!res.ok) return `Error: web search failed — DuckDuckGo returned ${res.status}.`;
  const html = await res.text();

  // Parse result blocks: <a class="result__a" href="...">Title</a> + snippet
  const results: { title: string; url: string; snippet: string }[] = [];
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = m[1];
    // DDG wraps URLs: //duckduckgo.com/l/?uddg=<encoded>&rut=…
    const uddg = rawUrl.match(/[?&]uddg=([^&]+)/);
    const finalUrl = uddg ? decodeURIComponent(uddg[1]) : rawUrl.startsWith("http") ? rawUrl : `https:${rawUrl}`;
    const title = decodeDuckEntity(m[2].replace(/<[^>]+>/g, "")).trim();
    const snippetRaw = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetRaw ? decodeDuckEntity(snippetRaw[1].replace(/<[^>]+>/g, "")).trim() : "";
    if (title && finalUrl.startsWith("http")) {
      results.push({ title, url: finalUrl, snippet });
    }
  }

  if (results.length === 0) {
    return `No results found for "${query}". (The search engine may be rate-limiting — try again shortly or use fetch_url on a known page.)`;
  }

  return (
    `Web results for "${query}":\n\n` +
    results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n")
  );
}

/** Fetch a page and return readable text, truncated. */
async function fetchPage(url: string, maxChars: number): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: invalid URL "${url}".`;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return `Error: only http(s) URLs are supported.`;
  }
  const res = await fetchWithTimeout(url, 20000);
  if (!res.ok) return `Error: ${url} responded ${res.status} ${res.statusText}.`;
  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/|json|xml|html/i.test(contentType)) {
    return `Error: "${url}" returns ${contentType} — not a text page. Web images/binaries cannot be read as text.`;
  }
  const html = await res.text();
  const text = htmlToText(html);
  const truncated = text.length > maxChars ? text.slice(0, maxChars) + `\n\n… [truncated, ${text.length - maxChars} chars omitted]` : text;
  return `Content of ${url}:\n\n${truncated}`;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for current information (news, docs, facts, error messages, library versions). Returns titled result links with short snippets. Use fetch_url to read a specific result page in full.",
  permission: "auto",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The web search query" },
      max_results: { type: "number", description: "Optional number of results (default 6, max 10)" },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return "Error: empty search query.";
    const maxResults = Math.min(Number(args.max_results ?? 6) || 6, 10);
    try {
      return await webSearch(query, maxResults);
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      void ctx;
      return `Error: web search failed — ${(err as Error).message}. The machine may be offline or the search engine is blocking requests.`;
    }
  },
};

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch a web page by URL and return its readable text content (HTML converted to text, truncated to a manageable size). Use after web_search to read a specific result, or to look up documentation pages directly.",
  permission: "auto",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to fetch" },
      max_chars: { type: "number", description: "Optional max characters returned (default 12000)" },
    },
    required: ["url"],
  },
  async execute(args, ctx) {
    const url = String(args.url ?? "").trim();
    if (!url) return "Error: empty URL.";
    const maxChars = Math.min(Number(args.max_chars ?? 12000) || 12000, 40000);
    try {
      return await fetchPage(url, maxChars);
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      void ctx;
      return `Error: fetch failed — ${(err as Error).message}.`;
    }
  },
};
