import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { makeStack } from "./harness";

async function upload(app: ReturnType<typeof createApp>, root: string, dir: string | undefined, name: string, bytes: Uint8Array) {
  const params = new URLSearchParams(dir !== undefined ? { root, path: dir } : { root });
  return app.request(`/api/fs/upload?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    body: bytes,
  });
}

describe("POST /api/fs/upload", () => {
  test("writes a file into a workspace folder and returns its absolute path", async () => {
    const stack = makeStack();
    try {
      const root = join(stack.dir, "ws");
      mkdirSync(root, { recursive: true });
      stack.deps.configStore.update({ workspaces: [root] });
      const app = createApp(stack.deps);

      const res = await upload(app, root, root, "notes.txt", new TextEncoder().encode("hello"));
      expect(res.status).toBe(201);
      const { uploaded } = (await res.json()) as { uploaded: { path: string; name: string; bytes: number } };
      expect(uploaded.name).toBe("notes.txt");
      // macOS realpath resolves /var → /private/var; the server returns the
      // realpath-based absolute path.
      expect(uploaded.path).toBe(join(realpathSync(root), "notes.txt"));
      expect(readFileSync(uploaded.path, "utf8")).toBe("hello");
    } finally {
      stack.cleanup();
    }
  });

  test("auto-renames on collision instead of overwriting", async () => {
    const stack = makeStack();
    try {
      const root = join(stack.dir, "ws");
      mkdirSync(root, { recursive: true });
      stack.deps.configStore.update({ workspaces: [root] });
      const app = createApp(stack.deps);

      const first = await upload(app, root, root, "report.pdf", new Uint8Array([1]));
      const second = await upload(app, root, root, "report.pdf", new Uint8Array([2]));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const a = (await first.json()) as { uploaded: { name: string; path: string } };
      const b = (await second.json()) as { uploaded: { name: string; path: string } };
      expect(a.uploaded.name).toBe("report.pdf");
      expect(b.uploaded.name).toBe("report (1).pdf");
      expect(readFileSync(a.uploaded.path)[0]).toBe(1);
      expect(readFileSync(b.uploaded.path)[0]).toBe(2);
    } finally {
      stack.cleanup();
    }
  });

  test("rejects an unregistered root", async () => {
    const stack = makeStack();
    try {
      const root = join(stack.dir, "ws");
      mkdirSync(root, { recursive: true });
      const app = createApp(stack.deps);
      const res = await upload(app, root, root, "a.txt", new Uint8Array([1]));
      expect(res.status).toBe(400);
    } finally {
      stack.cleanup();
    }
  });

  test("rejects a directory that escapes the workspace", async () => {
    const stack = makeStack();
    try {
      const root = join(stack.dir, "ws");
      mkdirSync(root, { recursive: true });
      stack.deps.configStore.update({ workspaces: [root] });
      const app = createApp(stack.deps);
      const res = await upload(app, root, stack.dir, "evil.txt", new Uint8Array([1]));
      expect(res.status).toBe(400);
      expect(existsSync(join(stack.dir, "evil.txt"))).toBe(false);
    } finally {
      stack.cleanup();
    }
  });

  test("rejects a traversing file name", async () => {
    const stack = makeStack();
    try {
      const root = join(stack.dir, "ws");
      mkdirSync(root, { recursive: true });
      stack.deps.configStore.update({ workspaces: [root] });
      const app = createApp(stack.deps);
      const res = await upload(app, root, root, "../escape.txt", new Uint8Array([1]));
      expect(res.status).toBe(400);
      expect(existsSync(join(stack.dir, "escape.txt"))).toBe(false);
    } finally {
      stack.cleanup();
    }
  });
});
