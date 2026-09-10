import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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

    // agents.default round-trips through the same boundary (the agent
    // existence check happens at drain, not at config-write time).
    const putAgent = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ agents: { default: "build" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(putAgent.status).toBe(200);
    const { config: withAgent } = (await putAgent.json()) as { config: { agents: { default?: string } } };
    expect(withAgent.agents.default).toBe("build");

    // theme round-trips as a plain string (unknown ids fall back at apply
    // time — the boundary doesn't enum-check).
    const putTheme = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ theme: "dracula" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(putTheme.status).toBe(200);
    const { config: withTheme } = (await putTheme.json()) as { config: { theme?: string } };
    expect(withTheme.theme).toBe("dracula");

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

  test("GET /api/fs/find ranks workspace files and rejects unregistered roots", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    const stranger = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "index.ts"), "x");
      writeFileSync(join(root, "README.md"), "x");
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "x.js"), "x");
      registerWorkspaces(stack, [root]);

      const res = await app.request(`/api/fs/find?root=${encodeURIComponent(root)}&q=index`);
      expect(res.status).toBe(200);
      const { found } = (await res.json()) as {
        found: { root: string; results: { path: string; type: string }[]; truncated: boolean };
      };
      expect(found.results[0]?.path).toBe("src/index.ts");
      expect(found.results.some((r) => r.path.includes("node_modules"))).toBe(false);

      const all = await app.request(`/api/fs/find?root=${encodeURIComponent(root)}`);
      expect(all.status).toBe(200);

      const unregistered = await app.request(`/api/fs/find?root=${encodeURIComponent(stranger)}`);
      expect(unregistered.status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stranger, { recursive: true, force: true });
    }
  });

  test("GET /api/fs and /api/fs/file resolve a workspace-relative path against root", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "note.md"), "hello");
      registerWorkspaces(stack, [root]);

      const listing = await app.request(`/api/fs?root=${encodeURIComponent(root)}&path=nested`);
      expect(listing.status).toBe(200);
      const body = (await listing.json()) as { listing: { path: string } };
      expect(body.listing.path).toBe(realpathSync(join(root, "nested")));

      const file = await app.request(`/api/fs/file?root=${encodeURIComponent(root)}&path=nested/note.md`);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe("hello");

      // Relative traversal is still contained by the root.
      const escape = await app.request(`/api/fs?root=${encodeURIComponent(root)}&path=../`);
      expect(escape.status).toBe(400);
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

  test("GET /api/fs/file serves text and media bytes (sanitized mime, nosniff)", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      writeFileSync(join(root, "readme.md"), "# hello\n");
      writeFileSync(join(root, "page.html"), "<html><body>hi</body></html>");
      writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      writeFileSync(join(root, "doc.pdf"), Buffer.from("%PDF-1.4\n"));
      registerWorkspaces(stack, [root]);

      // Text file: raw bytes, text/plain, nosniff.
      const text = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "readme.md"))}`,
      );
      expect(text.status).toBe(200);
      expect(text.headers.get("content-type")).toBe("text/plain");
      expect(text.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await text.text()).toBe("# hello\n");

      // SECURITY POLICY: html serves as text/plain (source view), never
      // text/html — a blob iframe on the app origin must not get documents.
      const html = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "page.html"))}`,
      );
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toBe("text/plain");

      // Media: mime from the extension map.
      const png = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "pic.png"))}`,
      );
      expect(png.status).toBe(200);
      expect(png.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await png.arrayBuffer());
      expect(bytes[0]).toBe(0x89);

      const pdf = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "doc.pdf"))}`,
      );
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/fs/file rejects traversal, unregistered roots, dirs, and oversized files", async () => {
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    const stranger = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      writeFileSync(join(root, "f.txt"), "x");
      registerWorkspaces(stack, [root]);

      // Escape via ..
      const escape = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, ".."))}`,
      );
      expect(escape.status).toBe(400);

      // Escape via symlink pointing outside the workspace.
      symlinkSync(stranger, join(root, "out"));
      const viaLink = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "out"))}`,
      );
      expect(viaLink.status).toBe(400);

      // Unregistered root.
      const unregistered = await app.request(
        `/api/fs/file?root=${encodeURIComponent(stranger)}&path=${encodeURIComponent(join(stranger, "whatever"))}`,
      );
      expect(unregistered.status).toBe(400);
      expect(((await unregistered.json()) as { error: string }).error).toContain("not a registered workspace");

      // A directory, not a file.
      mkdirSync(join(root, "dir"));
      const dir = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "dir"))}`,
      );
      expect(dir.status).toBe(400);
      expect(((await dir.json()) as { error: string }).error).toBe("path is not a file");

      // Missing file.
      const missing = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "nope.txt"))}`,
      );
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe("path not found");

      // Text over the 1 MB cap.
      writeFileSync(join(root, "big.txt"), "x".repeat(1024 * 1024 + 1));
      const bigText = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "big.txt"))}`,
      );
      expect(bigText.status).toBe(400);
      expect(((await bigText.json()) as { error: string }).error).toBe("file too large");

      // Media over the 64 MB cap (sparse file — no bytes written).
      const bigPng = join(root, "big.png");
      writeFileSync(bigPng, "");
      truncateSync(bigPng, 64 * 1024 * 1024 + 1);
      const bigMedia = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(bigPng)}`,
      );
      expect(bigMedia.status).toBe(400);
      expect(((await bigMedia.json()) as { error: string }).error).toBe("file too large");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stranger, { recursive: true, force: true });
    }
  });

  test("GET /api/fs/file reports permission denied for unreadable files", async () => {
    if ((process.getuid?.() ?? 0) === 0) return; // root reads everything
    const root = mkdtempSync(join("/tmp", "bai-fs-"));
    try {
      writeFileSync(join(root, "secret.txt"), "x");
      registerWorkspaces(stack, [root]);
      chmodSync(join(root, "secret.txt"), 0o000);

      const denied = await app.request(
        `/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "secret.txt"))}`,
      );
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error: string }).error).toBe("permission denied");

      chmodSync(join(root, "secret.txt"), 0o644); // allow cleanup
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/permission/:id/reply carries scope and message (always persists; feedback recorded)", async () => {
    const session = stack.core.createSession({ workbench: "code" });
    // Raise an ask directly through the gate (unmatched tool → "ask").
    const pending = stack.core.permissions.authorize({ tool: "custom.danger", sessionId: session.id, metadata: {} });
    // Snapshot exposes it before any reply.
    const snap = stack.core.sessionSnapshot(session.id);
    expect(snap.pendingPermissions).toHaveLength(1);
    const requestId = snap.pendingPermissions[0]!.id as string;

    const res = await app.request(`/api/permission/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ status: "approved", scope: "always" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await pending).toEqual({
      allowed: true,
      ask: { status: "approved", scope: "always" },
    });
    // scope=always persisted into session meta (regression: the route used to drop scope).
    const meta = stack.core.getSession(session.id)?.meta as { approvals?: Record<string, string> };
    expect(meta.approvals?.["custom.danger"]).toBe("allow");

    // Rejection with feedback: the message must survive the HTTP boundary.
    const pending2 = stack.core.permissions.authorize({ tool: "custom.other", sessionId: session.id, metadata: {} });
    const snap2 = stack.core.sessionSnapshot(session.id);
    const id2 = snap2.pendingPermissions[0]!.id as string;
    const res2 = await app.request(`/api/permission/${id2}/reply`, {
      method: "POST",
      body: JSON.stringify({ status: "rejected", scope: "once", message: "no thanks" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res2.status).toBe(200);
    const verdict = await pending2;
    expect(verdict.allowed).toBe(false);
    expect(verdict.feedback).toBe("no thanks");
    expect(verdict.ask).toEqual({
      status: "rejected",
      scope: "once",
      message: "no thanks",
    });
  });
});

describe("custom theme files", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    // Sandbox the theme directory (the default would be the real
    // ~/.config/bai/themes).
    stack.deps.themesDir = join(stack.dir, "themes");
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  const palette = {
    surface: "#101010",
    surfaceSecondary: "#1a1a1a",
    background: "#0a0a0a",
    text: "#eeeeee",
    textMuted: "#888888",
    border: "#2a2a2a",
    success: "#00cc88",
    danger: "#ff4455",
    warning: "#ffcc00",
    primary: "#4488ff",
    secondary: "#44ccff",
    accent: "#8844ff",
  };

  test("PUT → GET → DELETE roundtrip", async () => {
    const put = await app.request("/api/theme/custom/my-theme", {
      method: "PUT",
      body: JSON.stringify({ name: "My Theme", colors: palette }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const { theme } = (await put.json()) as { theme: { id: string; name: string; mode: string } };
    expect(theme.id).toBe("my-theme");
    expect(theme.name).toBe("My Theme");
    expect(theme.mode).toBe("dark"); // derived from the dark surface

    const list = await app.request("/api/theme/custom");
    const { themes } = (await list.json()) as { themes: { id: string }[] };
    expect(themes.map((t) => t.id)).toEqual(["my-theme"]);

    const del = await app.request("/api/theme/custom/my-theme", { method: "DELETE" });
    expect(del.status).toBe(200);
    const empty = await app.request("/api/theme/custom");
    expect(((await empty.json()) as { themes: unknown[] }).themes).toEqual([]);
  });

  test("rejects invalid ids and palettes", async () => {
    // Uppercase/underscore ids fail the slug guard (also blocks traversal —
    // the pattern allows only [a-z0-9-]).
    const badId = await app.request("/api/theme/custom/Bad_ID", {
      method: "PUT",
      body: JSON.stringify({ name: "x", colors: palette }),
      headers: { "Content-Type": "application/json" },
    });
    expect(badId.status).toBe(400);

    const badColor = await app.request("/api/theme/custom/bad", {
      method: "PUT",
      body: JSON.stringify({ name: "bad", colors: { ...palette, surface: "not-a-hex" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(badColor.status).toBe(400);

    const missing = await app.request("/api/theme/custom/nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});
