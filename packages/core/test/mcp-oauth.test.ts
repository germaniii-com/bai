import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";
import { ToolRegistry } from "../src/tools/registry";
import { McpRegistry } from "../src/mcp/registry";
import { McpManager } from "../src/mcp/manager";

/** A minimal OAuth-protected remote MCP server: 401 + metadata + DCR. */
interface FakeOAuthServer {
  url: string;
  close: () => Promise<void>;
}

function fakeOAuthServer(): Promise<FakeOAuthServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const base = `http://${req.headers.host ?? "127.0.0.1"}`;
      const url = req.url ?? "/";
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url.startsWith("/mcp")) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      if (url.startsWith("/.well-known/oauth-protected-resource")) {
        json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
        return;
      }
      if (url.startsWith("/.well-known/oauth-authorization-server")) {
        json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
        return;
      }
      if (url === "/register" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          let redirectUris: string[] = [];
          try {
            redirectUris = (JSON.parse(body) as { redirect_uris?: string[] }).redirect_uris ?? [];
          } catch {
            // ignore malformed body
          }
          json(201, { client_id: "test-client", redirect_uris: redirectUris });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface Stack {
  dir: string;
  tokensDir: string;
  registry: McpRegistry;
  manager: McpManager;
}

const stacks: Stack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.manager.stop();
    stack.registry.stop();
    rmSync(stack.dir, { recursive: true, force: true });
    rmSync(stack.tokensDir, { recursive: true, force: true });
  }
});

function makeStack(): Stack {
  const config: Config = { ...DEFAULT_CONFIG, mcp: {} };
  const dir = mkdtempSync(join(tmpdir(), "bai-mcp-oauth-"));
  const tokensDir = mkdtempSync(join(tmpdir(), "bai-mcp-oauth-tokens-"));
  const registry = new McpRegistry({ dir, config: () => config, pollMs: 0 });
  const manager = new McpManager({ registry, tools: new ToolRegistry(), version: "test", tokensDir, connectTimeoutMs: 8000 });
  const stack = { dir, tokensDir, registry, manager };
  stacks.push(stack);
  return stack;
}

describe("McpManager OAuth", () => {
  test("startAuth returns a URL whose redirect_uri is a live loopback listener", async () => {
    const as = await fakeOAuthServer();
    const stack = makeStack();
    stack.registry.put("remote", { transport: "http", url: as.url, oauth: true, timeout: 5000 });
    try {
      await stack.manager.start();
      expect(stack.manager.status()[0]?.state).toBe("needs_auth");

      const authorizationUrl = await stack.manager.startAuth("remote");
      const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
      expect(redirectUri).not.toBeNull();
      // The regression: the redirect URI must actually be listening.
      const probe = await fetch(redirectUri as string);
      expect(probe.status).toBe(200);
      expect(await probe.text()).toContain("Authorized");
    } finally {
      await stack.manager.stop();
      await as.close();
    }
  }, 20_000);
});
