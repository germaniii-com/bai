import TurndownService from "turndown";
import { Parser } from "htmlparser2";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * web.fetch — fetch a URL and return its content as markdown/text/html
 * (opencode's webfetch ported to Bun's fetch). Permission-gated by the
 * central gate (unmatched → "ask"), like every tool.
 *
 * Request strategy (opencode webfetch.ts): Chrome UA + per-format Accept
 * negotiation; a 403 carrying `cf-mitigated: challenge` gets exactly one
 * retry with the honest UA (TLS-fingerprint mismatch workaround); response
 * capped at 5MB (content-length pre-check + actual byte count); HTML →
 * markdown via turndown, HTML → text via htmlparser2 with skip tags.
 */

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_UA = "bai";

const turndown = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});
turndown.remove(["script", "style", "meta", "link"]);

function acceptHeaderFor(format: string): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
    default:
      return "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
  }
}

/** htmlparser2 with skip tags (opencode's extractTextFromHTML). */
function extractTextFromHTML(html: string): string {
  let text = "";
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++;
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

/** Whitespace-normalizing wrapper (raw node concatenation is unusable for LLMs). */
function cleanText(raw: string): string {
  return raw
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function webFetchTool(opts: { fetchImpl?: typeof fetch } = {}): Tool {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: "web.fetch",
    origin: "builtin",
    description:
      "Fetch content from a URL and return it as markdown (default), text, or html. " +
      "Use for reading web pages, documentation, and articles. The URL must be fully-formed " +
      "and start with http:// or https://. Read-only. Results may be truncated if very large.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch content from" },
        format: { type: "string", enum: ["text", "markdown", "html"], description: "Return format (default markdown)" },
        timeout: { type: "number", description: "Optional timeout in seconds (max 120)" },
      },
      required: ["url"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { url, format, timeout } = args as { url?: string; format?: string; timeout?: number };
      if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        throw new Error("URL must start with http:// or https://");
      }
      const fmt = ["text", "markdown", "html"].includes(format ?? "") ? (format as string) : "markdown";
      const timeoutMs = Math.min((timeout ?? DEFAULT_TIMEOUT_S) * 1000, MAX_TIMEOUT_S * 1000);

      const headers = {
        "User-Agent": CHROME_UA,
        Accept: acceptHeaderFor(fmt),
        "Accept-Language": "en-US,en;q=0.9",
      };
      let response = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      // Cloudflare bot detection (TLS fingerprint mismatch): one honest-UA retry.
      if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
        response = await doFetch(url, { headers: { ...headers, "User-Agent": HONEST_UA }, signal: AbortSignal.timeout(timeoutMs) });
      }
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)");
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)");
      }

      const contentType = response.headers.get("content-type") ?? "";
      const title = `${url} (${contentType})`;
      const content = new TextDecoder().decode(arrayBuffer);

      if (fmt === "markdown") {
        const output = contentType.includes("text/html") ? turndown.turndown(content) : content;
        return { content: `${title}\n\n${output}`, meta: { url, format: fmt } };
      }
      if (fmt === "text") {
        const output = contentType.includes("text/html") ? cleanText(extractTextFromHTML(content)) : content;
        return { content: `${title}\n\n${output}`, meta: { url, format: fmt } };
      }
      return { content: `${title}\n\n${content}`, meta: { url, format: fmt } };
    },
  };
}
