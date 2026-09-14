import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../src";
import { OAuthLoginManager } from "../src";
import type { OAuthFlowSpec } from "../src";
import { renewOAuthTokens } from "../src/provider/oauth/refresh";
import { runRedirectFlow } from "../src/provider/oauth/redirect";
import { pkcePair } from "../src/provider/oauth/pkce";
import { toAnthropicMessages, toAnthropicTools } from "../src/provider/adapters/anthropic";
import { buildToolNameMap } from "../src/provider/tool-names";

function store(): { accounts: AuthStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bai-oauth-"));
  return { accounts: new AuthStore({ file: join(dir, "auth.json") }), dir };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("OAuthLoginManager", () => {
  test("device-code: start returns the user code, then the account is written", async () => {
    const { accounts, dir } = store();
    // A gate keeps the flow pending so `start` returns before completion
    // (real device flows block on polling; a synchronous fake would race).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spec: OAuthFlowSpec = {
      id: "fake-device",
      name: "Fake Device",
      method: "device_code",
      accountId: "acct",
      run: async (ctx) => {
        ctx.progress({ status: "pending", userCode: "ABCD-1234", verificationUri: "https://example.com/device" });
        await gate;
        return { access: "access-1", refresh: "refresh-1", expiresAt: 123 };
      },
    };
    const mgr = new OAuthLoginManager({ accounts, specs: { "fake-device": spec }, now: () => 1000 });
    const session = await mgr.start("fake-device");
    expect(session.status).toBe("pending");
    expect(session.userCode).toBe("ABCD-1234");
    expect(session.verificationUri).toBe("https://example.com/device");

    release();
    await tick();
    expect(accounts.hasOAuth("fake-device")).toBe(true);
    const resolved = accounts.resolve("fake-device", "acct");
    expect(resolved?.apiKey).toBe("access-1");
    expect(resolved?.refreshToken).toBe("refresh-1");
    expect(mgr.poll(session.id)?.status).toBe("approved");
    rmSync(dir, { recursive: true, force: true });
  });

  test("paste-code: waits for submit, then completes", async () => {
    const { accounts, dir } = store();
    const spec: OAuthFlowSpec = {
      id: "fake-paste",
      name: "Fake Paste",
      method: "paste_code",
      run: async (ctx) => {
        ctx.progress({ authorizeUrl: "https://example.com/authorize" });
        const code = await ctx.waitForCode();
        return { access: `access:${code}` };
      },
    };
    const mgr = new OAuthLoginManager({ accounts, specs: { "fake-paste": spec } });
    const session = await mgr.start("fake-paste");
    expect(session.status).toBe("awaiting_code");
    expect(session.authorizeUrl).toBe("https://example.com/authorize");

    mgr.submit(session.id, "code#state");
    await tick();
    expect(accounts.resolve("fake-paste", "oauth")?.apiKey).toBe("access:code#state");
    rmSync(dir, { recursive: true, force: true });
  });

  test("cancel aborts a paste flow", async () => {
    const { accounts, dir } = store();
    const spec: OAuthFlowSpec = {
      id: "fake-cancel",
      name: "Fake Cancel",
      method: "paste_code",
      run: async (ctx) => {
        ctx.progress({ authorizeUrl: "https://example.com/authorize" });
        await ctx.waitForCode();
        return { access: "never" };
      },
    };
    const mgr = new OAuthLoginManager({ accounts, specs: { "fake-cancel": spec } });
    const session = await mgr.start("fake-cancel");
    expect(mgr.cancel(session.id)).toBe(true);
    await tick();
    expect(accounts.has("fake-cancel")).toBe(false);
    expect(mgr.poll(session.id)?.status).toBe("cancelled");
    rmSync(dir, { recursive: true, force: true });
  });

  test("import flow completes immediately", async () => {
    const { accounts, dir } = store();
    const spec: OAuthFlowSpec = {
      id: "fake-import",
      name: "Fake Import",
      method: "import",
      run: async () => ({ access: "imported" }),
    };
    const mgr = new OAuthLoginManager({ accounts, specs: { "fake-import": spec } });
    const session = await mgr.start("fake-import");
    expect(session.status).toBe("approved");
    expect(accounts.resolve("fake-import")?.apiKey).toBe("imported");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("OAuth refresh", () => {
  test("single-flight: concurrent renewals share one refresh call", async () => {
    const { accounts, dir } = store();
    accounts.setOAuth("singleflight", "a", { access: "old", refresh: "r0", expiresAt: 1 });
    let calls = 0;
    const spec: OAuthFlowSpec = {
      id: "singleflight",
      name: "Single Flight",
      method: "import",
      run: async () => ({ access: "x" }),
      refresh: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { access: "new", refresh: "r1", expiresAt: Date.now() + 3600_000 };
      },
    };
    const { OAUTH_SPECS } = await import("../src/provider/oauth/specs");
    const prior = OAUTH_SPECS.singleflight;
    OAUTH_SPECS.singleflight = spec;
    try {
      const deps = { accounts };
      const [a, b] = await Promise.all([
        renewOAuthTokens("singleflight", "a", { access: "old", refresh: "r0" }, deps),
        renewOAuthTokens("singleflight", "a", { access: "old", refresh: "r0" }, deps),
      ]);
      expect(calls).toBe(1);
      expect(a.access).toBe("new");
      expect(b.access).toBe("new");
      expect(accounts.resolve("singleflight", "a")?.apiKey).toBe("new");
    } finally {
      if (prior === undefined) delete OAUTH_SPECS.singleflight;
      else OAUTH_SPECS.singleflight = prior;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("PKCE", () => {
  test("challenge is the S256 hash of the verifier (base64url, no padding)", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const { createHash } = require("node:crypto");
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });
});

describe("loopback redirect flow", () => {
  /** Raw HTTP GET over a TCP socket (Bun's fetch can spuriously reset against a fresh in-process listener). */
  function rawGet(port: number, path: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(new Error("raw request timed out"));
      });
    });
  }

  test("binds a callback server, receives the code, and exchanges it", async () => {
    const controller = new AbortController();
    let redirectUri = "";
    let authorizeUrl = "";
    const flow = runRedirectFlow({
      port: 0,
      path: "/cb",
      timeoutMs: 4000,
      authorizeUrl: (uri, pkce) => {
        redirectUri = uri;
        authorizeUrl = `https://example.com/authorize?state=${pkce.state}&redirect_uri=${encodeURIComponent(uri)}`;
        return authorizeUrl;
      },
      exchange: async (code, c) => ({ access: code, refresh: c.state }),
      signal: controller.signal,
      now: () => 1000,
      progress: (u) => {
        if (u.authorizeUrl !== undefined) authorizeUrl = u.authorizeUrl;
      },
    });

    for (let i = 0; i < 50 && redirectUri.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/cb$/);
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);

    const port = Number(new URL(redirectUri).port);
    const page = await rawGet(port, `/cb?code=abc&state=${state}`);
    expect(page).toContain("200");
    expect(page).toContain("Signed in to bai");

    const tokens = await flow;
    expect(tokens.access).toBe("abc");
    expect(tokens.refresh).toBe(state);
  });

  test("rejects when the returned state does not match (CSRF guard)", async () => {
    const controller = new AbortController();
    let redirectUri = "";
    const flow = runRedirectFlow({
      port: 0,
      path: "/cb",
      timeoutMs: 4000,
      authorizeUrl: (uri) => {
        redirectUri = uri;
        return `https://example.com/authorize?redirect_uri=${encodeURIComponent(uri)}`;
      },
      exchange: async () => ({ access: "never" }),
      signal: controller.signal,
      now: () => 1000,
      progress: () => undefined,
    });
    // Attach a rejection handler immediately (no unhandled-rejection risk).
    const outcome = flow.then(
      () => undefined,
      (err: Error) => err,
    );
    for (let i = 0; i < 50 && redirectUri.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const port = Number(new URL(redirectUri).port);
    await rawGet(port, "/cb?code=abc&state=wrong");
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/state mismatch/);
  });
});

describe("multiple OAuth accounts per provider", () => {
  test("two accounts coexist and resolve independently; reconnect replaces one", () => {
    const { accounts, dir } = store();
    accounts.setOAuth("multi", "work", { access: "work-token", refresh: "w-r", accountId: "id-work" });
    accounts.setOAuth("multi", "personal", { access: "personal-token", refresh: "p-r", accountId: "id-personal" });
    expect(accounts.list("multi")).toHaveLength(2);
    expect(accounts.resolve("multi", "work")?.apiKey).toBe("work-token");
    expect(accounts.resolve("multi", "personal")?.apiKey).toBe("personal-token");
    // Default = first listed (sorted by id → "personal").
    expect(accounts.resolve("multi")?.accountId).toBe("personal");

    // Reconnecting under an existing name replaces only that account.
    accounts.setOAuth("multi", "work", { access: "work-token-2" });
    expect(accounts.resolve("multi", "work")?.apiKey).toBe("work-token-2");
    expect(accounts.resolve("multi", "personal")?.apiKey).toBe("personal-token");
    rmSync(dir, { recursive: true, force: true });
  });

  test("manager.start({ account }) writes a distinct account", async () => {
    const { accounts, dir } = store();
    const spec: OAuthFlowSpec = {
      id: "multi-oauth",
      name: "Multi OAuth",
      method: "import",
      run: async (ctx) => ({ access: `token:${ctx.accountId}` }),
    };
    const mgr = new OAuthLoginManager({ accounts, specs: { "multi-oauth": spec } });
    await mgr.start("multi-oauth", { account: "work" });
    await mgr.start("multi-oauth", { account: "personal" });
    expect(accounts.resolve("multi-oauth", "work")?.apiKey).toBe("token:work");
    expect(accounts.resolve("multi-oauth", "personal")?.apiKey).toBe("token:personal");
    expect(accounts.list("multi-oauth")).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Anthropic OAuth wire shape", () => {
  test("tools and replayed tool_use names use the mcp__ prefix", () => {
    const names = buildToolNameMap([{ name: "fs.read" }, { name: "mcp/server/search" }]);
    const tools = toAnthropicTools(
      [
        { name: "fs.read", schema: { type: "object" } },
        { name: "mcp/server/search", schema: { type: "object" } },
      ],
      names,
      { oauth: true },
    );
    expect(tools[0]?.name).toBe("mcp__fs_read");
    expect(tools[1]?.name.startsWith("mcp__")).toBe(true);

    const msgs = toAnthropicMessages(
      [{ role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "fs.read", args: "{}" }] }],
      { toolNames: names, oauth: true },
    );
    const block = msgs[0]?.content[0] as { name?: string };
    expect(block.name).toBe("mcp__fs_read");
  });

  test("non-OAuth path keeps the plain sanitized names", () => {
    const names = buildToolNameMap([{ name: "fs.read" }]);
    const tools = toAnthropicTools([{ name: "fs.read", schema: { type: "object" } }], names);
    expect(tools[0]?.name).toBe("fs_read");
  });
});
