/**
 * Private JSON-RPC `tools/call` transport for the built-in web-search
 * providers (Exa / Parallel public MCP endpoints).
 *
 * This is NOT the MCP client manager (`core/src/mcp`) and is NOT registered
 * as a tool — it is a fixed-endpoint helper owned by `web.search`/`web.fetch`,
 * mirroring opencode's internal `mcp-websearch.ts`. It has no discovery, auth
 * negotiation, or reconnect: the providers know their endpoint and tool name.
 */

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpCallOptions {
  url: string;
  tool: string;
  args: Record<string, unknown>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface McpContentItem {
  type?: string;
  text?: string;
}

interface McpEnvelope {
  error?: { message?: string };
  result?: { content?: McpContentItem[]; isError?: boolean };
}

/** Parse one JSON-RPC payload into its first text content item. */
function parsePayload(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const envelope = data as McpEnvelope;
  if (envelope.error !== undefined) {
    throw new McpError(envelope.error.message ?? "MCP JSON-RPC error");
  }
  const result = envelope.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  if (result.isError === true) {
    const text = content
      .map((item) => item.text ?? "")
      .filter((t) => t.length > 0)
      .join(" ");
    throw new McpError(text.length > 0 ? text : "MCP tool call failed");
  }
  const item = content.find((c) => typeof c.text === "string" && c.text.length > 0);
  return item?.text;
}

/**
 * Extract the first text content item from an MCP response body. Handles
 * direct JSON and SSE (`data: {...}` lines) transports; returns undefined when
 * the body has no recognizable text (e.g. an empty 200).
 */
export function parseMcpText(body: string): string | undefined {
  if (body.trim().length === 0) return undefined;
  const direct = parsePayload(body);
  if (direct !== undefined) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = parsePayload(line.slice(5).trim());
    if (data !== undefined) return data;
  }
  return undefined;
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * POST a JSON-RPC `tools/call` and return the text payload. Throws `McpError`
 * on transport failure, non-2xx status, JSON-RPC error, `isError` result, an
 * oversized body, or an unrecognized response shape.
 */
export async function callMcp(opts: McpCallOptions): Promise<string | undefined> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await doFetch(opts.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...opts.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: opts.tool, arguments: opts.args },
    }),
    signal: timeoutSignal(opts.signal, timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail.trim().length > 0 ? `: ${detail.trim().slice(0, 300)}` : "";
    throw new McpError(`HTTP ${response.status}${suffix}`);
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new McpError(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  const text = parseMcpText(body);
  if (text === undefined) throw new McpError("unrecognized MCP response");
  return text;
}

/** Normalize any thrown value into a provider-facing message. */
export function mcpErrorMessage(err: unknown): string {
  if (err instanceof McpError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
