import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, shellAuthorized, shellWebSocketHandlers, type ShellSocketData } from "../src";
import { makeStack, type TestStack } from "./harness";

/**
 * Web shell integration tests: the /api/shell capability probe, the WS
 * upgrade auth policy, and one real command round trip through the PTY
 * bridge (skipped when no bridge exists — e.g. Windows CI).
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("shell", () => {
  let stack: TestStack;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    stack = makeStack();
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => {
        if (new URL(req.url).pathname === "/api/shell/ws") {
          if (!shellAuthorized(req, { token: stack.deps.token, loopbackBind: stack.deps.loopbackBind })) {
            return new Response("unauthorized", { status: 401 });
          }
          if (srv.upgrade(req, { data: { session: null } satisfies ShellSocketData })) {
            return undefined as unknown as Response;
          }
          return new Response("upgrade failed", { status: 400 });
        }
        return createApp(stack.deps).fetch(req, srv);
      },
      websocket: shellWebSocketHandlers(),
    });
  });

  afterEach(async () => {
    await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 1000))]);
    stack.cleanup();
  });

  test("capability probe reports availability", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; available: boolean };
    expect(body.ok).toBe(true);
    expect(typeof body.available).toBe("boolean");
  });

  test("upgrade auth: loopback bypasses, token mismatch denied, valid token accepted", () => {
    const url = `http://127.0.0.1:1/api/shell/ws`;
    const req = new Request(url);
    // Loopback: always allowed.
    expect(shellAuthorized(req, { loopbackBind: true })).toBe(true);
    expect(shellAuthorized(req, { loopbackBind: true, token: "t" })).toBe(true);
    // Beyond loopback: no token configured → deny (fail closed).
    expect(shellAuthorized(req, { loopbackBind: false })).toBe(false);
    // Beyond loopback: wrong/missing token → deny.
    expect(shellAuthorized(req, { loopbackBind: false, token: "secret" })).toBe(false);
    expect(
      shellAuthorized(new Request(`${url}?token=wrong`), { loopbackBind: false, token: "secret" }),
    ).toBe(false);
    // Beyond loopback: correct token → allowed.
    expect(
      shellAuthorized(new Request(`${url}?token=secret`), { loopbackBind: false, token: "secret" }),
    ).toBe(true);
  });

  test("command round trip over the WebSocket (real shell)", async () => {
    const probe = (await (await fetch(`http://127.0.0.1:${server.port}/api/shell`)).json()) as {
      available: boolean;
    };
    if (!probe.available) {
      console.log("(no shell backend on this machine — skipping round trip)");
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/shell/ws`);
    ws.binaryType = "arraybuffer";
    let out = "";
    const result = await Promise.race([
      (async () => {
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => setTimeout(() => ws.send("echo bai-ws-test-$((5*7))\n"), 300);
          ws.onmessage = (e) => {
            out += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
            if (out.includes("bai-ws-test-35")) resolve();
          };
          ws.onerror = () => reject(new Error("ws error"));
        });
        return "ok";
      })(),
      sleep(10_000).then(() => "timeout"),
    ]);
    ws.close();
    if (result === "timeout") throw new Error(`shell round trip timed out; got: ${JSON.stringify(out.slice(-300))}`);
    expect(out).toContain("bai-ws-test-35");
  });
});
