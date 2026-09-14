/**
 * Minimal stdio MCP server used by the McpManager tests. Speaks
 * newline-delimited JSON-RPC 2.0 over stdin/stdout and implements just enough
 * of the 2025-era protocol: `initialize`, `tools/list`, `tools/call`, `ping`.
 * Run with: `bun fixtures/mcp-echo-server.ts`.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  let msg: { id?: unknown; method?: string; params?: { protocolVersion?: string; arguments?: { text?: string } } };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "echo", version: "1.0.0" },
        },
      });
      break;
    case "notifications/initialized":
      break;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo the provided text back",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string", description: "Text to echo" } },
                required: ["text"],
              },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const text = String(msg.params?.arguments?.text ?? "");
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${text}` }] } });
      break;
    }
    default:
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
