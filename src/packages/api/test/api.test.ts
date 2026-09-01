import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

/** Point the stack's configStore at a config with the given workspace roots. */
function registerWorkspaces(stack: TestStack, roots: string[]): void {
  const base = stack.deps.configStore.get();
  stack.deps.configStore = {
    get: () => ({ ...base, workspaces: roots }),
    update: stack.deps.configStore.update,
  } as typeof stack.deps.configStore;
}

describe("api contract", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("GET /api/health", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "test" });
  });

  test("session lifecycle: create → get → list → 404", async () => {
    const created = await app.request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "t", workbench: "chat" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const got = await app.request(`/api/session/${session.id}`);
    expect(got.status).toBe(200);

    const listed = await app.request("/api/session");
    expect(((await listed.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);

    const missing = await app.request("/api/session/ses_nope");
    expect(missing.status).toBe(404);
  });

  test("submit validates body (zod)", async () => {
    const session = stack.core.createSession({ workbench: "chat" });
    const bad = await app.request(`/api/session/${session.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);

    const ok = await app.request(`/api/session/${session.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(ok.status).toBe(202);
  });

  test("submit to unknown session → 404", async () => {
    const res = await app.request("/api/session/ses_nope/message", {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("PUT /api/session/:id/title renames; 404 unknown; validates body", async () => {
    const session = stack.core.createSession({ workbench: "chat" });
    const res = await app.request(`/api/session/${session.id}/title`, {
      method: "PUT",
      body: JSON.stringify({ title: "renamed" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { session: { title: string } }).session.title).toBe("renamed");
    expect(stack.core.getSession(session.id)?.title).toBe("renamed");

    const missing = await app.request("/api/session/ses_nope/title", {
      method: "PUT",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(missing.status).toBe(404);

    const bad = await app.request(`/api/session/${session.id}/title`, {
      method: "PUT",
      body: JSON.stringify({ title: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  test("static hosting: hint page when dist is missing", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not built");
  });

  test("static hosting never shadows /api/*", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("bearer auth enforced when bound beyond loopback", async () => {
    stack.cleanup();
    stack = makeStack({ token: "secret-token-123", loopbackBind: false });
    app = createApp(stack.deps);

    const denied = await app.request("/api/health");
    expect(denied.status).toBe(401);

    const allowed = await app.request("/api/health", {
      headers: { Authorization: "Bearer secret-token-123" },
    });
    expect(allowed.status).toBe(200);
  });

  test("durable SSE stream: hello first, replay after cursor, run.finished", async () => {
    // Run a prompt to completion first so there are durable rows.
    const session = stack.core.createSession({ workbench: "chat" });
    stack.core.submitPrompt(session.id, { text: "stream me" });
    for (let i = 0; i < 100; i++) {
      if (!stack.core.coordinator.isActive(session.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const res = await app.request(`/api/session/${session.id}/event?after=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("SSE response has no body");
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: string[] = [];
    let sawHello = false;
    let sawFinished = false;

    const timeout = setTimeout(() => {
      void reader?.cancel();
    }, 3000);

    try {
      while (!sawFinished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          frames.push(frame);
          if (frame.startsWith("event: server.hello")) sawHello = true;
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine !== undefined && dataLine.includes("run.finished")) sawFinished = true;
        }
      }
    } finally {
      clearTimeout(timeout);
      void reader.cancel();
    }

    expect(sawHello).toBe(true);
    expect(sawFinished).toBe(true);
    // replay is ascending by seq (id: lines carry the cursor)
    const ids = frames
      .map((f) => f.split("\n").find((l) => l.startsWith("id: "))?.slice(4))
      .filter((x) => x !== undefined)
      .map(Number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("config GET/PUT roundtrip", async () => {
    const got = await app.request("/api/config");
    expect(got.status).toBe(200);

    const put = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { default: "stub/echo" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(200);

    const bad = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { port: -5 } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  test("config workspaces roundtrip (array replace semantics)", async () => {
    const put = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ workspaces: ["/tmp/a", "/tmp/b"] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(200);
    const { config } = (await put.json()) as { config: { workspaces: string[] } };
    expect(config.workspaces).toEqual(["/tmp/a", "/tmp/b"]);

    // Full-list replace: a later PUT without a removed path drops it.
    const put2 = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ workspaces: ["/tmp/a"] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put2.status).toBe(200);
    const { config: config2 } = (await put2.json()) as { config: { workspaces: string[] } };
    expect(config2.workspaces).toEqual(["/tmp/a"]);

    // Validation: non-string entries rejected.
    const bad = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ workspaces: [42] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  test("session list filters by workbench and cwd", async () => {
    stack.core.createSession({ workbench: "chat" });
    stack.core.createSession({ workbench: "code", cwd: "/ws/one" });
    stack.core.createSession({ workbench: "code", cwd: "/ws/two" });

    const all = await (await app.request("/api/session")).json();
    expect((all as { sessions: unknown[] }).sessions).toHaveLength(3);

    const chats = await (await app.request("/api/session?workbench=chat")).json();
    expect((chats as { sessions: unknown[] }).sessions).toHaveLength(1);

    const one = await (await app.request("/api/session?cwd=/ws/one")).json();
    const oneSessions = (one as { sessions: { cwd?: string }[] }).sessions;
    expect(oneSessions).toHaveLength(1);
    expect(oneSessions[0]?.cwd).toBe("/ws/one");

    const codeOne = await (await app.request("/api/session?workbench=code&cwd=/ws/one")).json();
    expect((codeOne as { sessions: unknown[] }).sessions).toHaveLength(1);

    const none = await (await app.request("/api/session?cwd=/ws/missing")).json();
    expect((none as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  test("GET /api/fs lists a directory (dirs first, capped)", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      mkdirSync(join(root, "sub"));
      mkdirSync(join(root, "zdir"));
      writeFileSync(join(root, "afile.txt"), "x");
      writeFileSync(join(root, ".hidden"), "x");
      registerWorkspaces(stack, [root]);

      const res = await app.request(`/api/fs?root=${encodeURIComponent(root)}`);
      expect(res.status).toBe(200);
      const { listing } = (await res.json()) as {
        listing: { path: string; root: string; entries: { name: string; type: string }[]; truncated: boolean };
      };
      // The server reports the realpath (macOS: /tmp → /private/tmp).
      expect(listing.root).toBe(realpathSync(root));
      expect(listing.truncated).toBe(false);
      expect(listing.entries).toEqual([
        { name: "sub", type: "dir" },
        { name: "zdir", type: "dir" },
        { name: ".hidden", type: "file" },
        { name: "afile.txt", type: "file" },
      ]);

      // Subdirectory listing stays inside the root.
      const sub = await app.request(
        `/api/fs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "sub"))}`,
      );
      expect(sub.status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/fs rejects traversal, invalid paths, and unregistered roots", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    const stranger = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      writeFileSync(join(root, "f.txt"), "x");
      registerWorkspaces(stack, [root]);

      // Escape via ..
      const escape = await app.request(
        `/api/fs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, ".."))}`,
      );
      expect(escape.status).toBe(400);

      // Escape via symlink pointing outside the workspace.
      symlinkSync(stranger, join(root, "out"));
      const viaLink = await app.request(
        `/api/fs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "out"))}`,
      );
      expect(viaLink.status).toBe(400);

      // A file, not a directory.
      const file = await app.request(
        `/api/fs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "f.txt"))}`,
      );
      expect(file.status).toBe(400);

      // Missing path.
      const missing = await app.request(
        `/api/fs?root=${encodeURIComponent(join(root, "nope"))}`,
      );
      expect(missing.status).toBe(400);

      // Missing root entirely.
      const noRoot = await app.request("/api/fs");
      expect(noRoot.status).toBe(400);

      // A real directory that is NOT a registered workspace → rejected even
      // though it exists (the tree can only browse registered workspaces).
      const unregistered = await app.request(`/api/fs?root=${encodeURIComponent(stranger)}`);
      expect(unregistered.status).toBe(400);
      const body = (await unregistered.json()) as { error: string };
      expect(body.error).toContain("not a registered workspace");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stranger, { recursive: true, force: true });
    }
  });

  test("GET /api/fs reports permission denied for unreadable folders", async () => {
    if ((process.getuid?.() ?? 0) === 0) return; // root reads everything
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      mkdirSync(join(root, "secret"));
      registerWorkspaces(stack, [root]);
      chmodSync(join(root, "secret"), 0o000);

      const denied = await app.request(
        `/api/fs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "secret"))}`,
      );
      expect(denied.status).toBe(400);
      const body = (await denied.json()) as { error: string };
      expect(body.error).toBe("permission denied");

      chmodSync(join(root, "secret"), 0o755); // allow cleanup
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/fs/stat validates a candidate workspace path", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      mkdirSync(join(root, "okdir"));
      writeFileSync(join(root, "f.txt"), "x");

      const ok = await app.request(`/api/fs/stat?path=${encodeURIComponent(join(root, "okdir"))}`);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { stat: { type: string } }).stat.type).toBe("dir");

      // Relative input resolves under the home directory ("." → home).
      const relStat = await app.request("/api/fs/stat?path=.");
      expect(relStat.status).toBe(200);
      expect(((await relStat.json()) as { stat: { path: string } }).stat.path).toBe(realpathSync(homedir()));

      const file = await app.request(`/api/fs/stat?path=${encodeURIComponent(join(root, "f.txt"))}`);
      expect(file.status).toBe(400);

      const missing = await app.request(`/api/fs/stat?path=${encodeURIComponent(join(root, "nope"))}`);
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe("path not found");

      if ((process.getuid?.() ?? 0) !== 0) {
        chmodSync(join(root, "okdir"), 0o000);
        const denied = await app.request(`/api/fs/stat?path=${encodeURIComponent(join(root, "okdir"))}`);
        expect(denied.status).toBe(400);
        expect(((await denied.json()) as { error: string }).error).toBe("permission denied");
        chmodSync(join(root, "okdir"), 0o755);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/fs/complete suggests child directories (prefix, hidden rule, ~)", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      mkdirSync(join(root, "alpha"));
      mkdirSync(join(root, "AlphaTwo"));
      mkdirSync(join(root, ".hiddendir"));
      mkdirSync(join(root, "zeta"));
      writeFileSync(join(root, "notadir"), "x");

      // Prefix match is case-insensitive; only directories; hidden only when prefix starts with ".".
      const m = await app.request(`/api/fs/complete?path=${encodeURIComponent(join(root, "al"))}`);
      expect(m.status).toBe(200);
      expect(((await m.json()) as { completion: { entries: string[] } }).completion.entries).toEqual([
        "alpha",
        "AlphaTwo",
      ]);

      // Trailing separator → all children (hidden filtered).
      const all = await app.request(`/api/fs/complete?path=${encodeURIComponent(`${root}/`)}`);
      expect(((await all.json()) as { completion: { entries: string[] } }).completion.entries).toEqual([
        "alpha",
        "AlphaTwo",
        "zeta",
      ]);

      // Dot prefix reveals hidden directories (raw string — path.join would
      // normalize the "." segment away).
      const dot = await app.request(`/api/fs/complete?path=${encodeURIComponent(`${root}/.`)}`);
      expect(
        ((await dot.json()) as { completion: { entries: string[] } }).completion.entries,
      ).toContain(".hiddendir");

      // dotfiles=1 reveals hidden directories without a dot prefix.
      const allWithDots = await app.request(
        `/api/fs/complete?path=${encodeURIComponent(`${root}/`)}&dotfiles=1`,
      );
      expect(
        ((await allWithDots.json()) as { completion: { entries: string[] } }).completion.entries,
      ).toContain(".hiddendir");

      // Empty input completes the home directory's children.
      const home = await app.request("/api/fs/complete?path=");
      expect(home.status).toBe(200);
      const homeBody = (await home.json()) as { completion: { base: string; entries: string[] } };
      expect(homeBody.completion.base).toBe(homedir());

      // Tilde expansion.
      const tilde = await app.request("/api/fs/complete?path=~%2F");
      expect(((await tilde.json()) as { completion: { base: string } }).completion.base).toBe(homedir());

      // Relative input searches under the home directory: base is home,
      // every suggestion matches the prefix (case-insensitive).
      const rel = await app.request("/api/fs/complete?path=d");
      expect(rel.status).toBe(200);
      const relBody = (await rel.json()) as { completion: { base: string; entries: string[] } };
      expect(relBody.completion.base).toBe(realpathSync(homedir()));
      expect(relBody.completion.entries.every((e) => e.toLowerCase().startsWith("d"))).toBe(true);

      // A relative path whose home-relative target doesn't exist → plain
      // "path not found" (no more "absolute path required" error).
      const relMissing = await app.request("/api/fs/complete?path=definitely-not-a-dir-xyz/");
      expect(relMissing.status).toBe(400);
      expect(((await relMissing.json()) as { error: string }).error).toBe("path not found");

      // Unreadable parent → permission denied.
      if ((process.getuid?.() ?? 0) !== 0) {
        chmodSync(root, 0o000);
        const denied = await app.request(`/api/fs/complete?path=${encodeURIComponent(`${root}/`)}`);
        expect(denied.status).toBe(400);
        expect(((await denied.json()) as { error: string }).error).toBe("permission denied");
        chmodSync(root, 0o755);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/fs/mkdir creates missing folders — inside home only", async () => {
    // Inject a sandbox home (Bun caches os.homedir(), so an env swap would
    // not work in-process) — the creation guard's boundary is the sandbox,
    // never the real home.
    const fakeHome = mkdtempSync(join("/tmp", "bai-home-"));
    stack.deps.home = fakeHome;
    const jsonHeaders = { "Content-Type": "application/json" };
    try {
      // Nested creation via ~.
      const nested = await app.request("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: "~/ws-new/nested" }),
        headers: jsonHeaders,
      });
      expect(nested.status).toBe(200);
      expect(existsSync(join(fakeHome, "ws-new", "nested"))).toBe(true);
      expect(((await nested.json()) as { stat: { type: string } }).stat.type).toBe("dir");

      // Relative input resolves under home.
      const rel = await app.request("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: "ws-rel" }),
        headers: jsonHeaders,
      });
      expect(rel.status).toBe(200);
      expect(existsSync(join(fakeHome, "ws-rel"))).toBe(true);

      // Idempotent: creating an existing directory succeeds.
      const again = await app.request("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: "~/ws-new/nested" }),
        headers: jsonHeaders,
      });
      expect(again.status).toBe(200);

      // Outside home: refused AND not created.
      const outside = await app.request("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: "/tmp/bai-mkdir-outside-xyz" }),
        headers: jsonHeaders,
      });
      expect(outside.status).toBe(400);
      expect(((await outside.json()) as { error: string }).error).toContain("home");
      expect(existsSync("/tmp/bai-mkdir-outside-xyz")).toBe(false);

      // Lexical .. escape: refused AND not created beside home.
      const dotdot = await app.request("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: "~/../escape-xyz" }),
        headers: jsonHeaders,
      });
      expect(dotdot.status).toBe(400);
      expect(existsSync(join(dirname(fakeHome), "escape-xyz"))).toBe(false);

      // Symlink escape: ~/link → /tmp; creating ~/link/evil must be refused.
      symlinkSync("/tmp", join(fakeHome, "link"));
      const viaLink = await app.request("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: "~/link/evil-xyz" }),
        headers: jsonHeaders,
      });
      expect(viaLink.status).toBe(400);
      expect(existsSync("/tmp/evil-xyz")).toBe(false);

      // Existing FILE at the path → not a directory.
      writeFileSync(join(fakeHome, "afile"), "x");
      const file = await app.request("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: "~/afile" }),
        headers: jsonHeaders,
      });
      expect(file.status).toBe(400);
      expect(((await file.json()) as { error: string }).error).toBe("path is not a directory");
    } finally {
      delete stack.deps.home;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
