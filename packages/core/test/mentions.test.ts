import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@bai/shared";
import { expandMentions } from "../src/run/mentions";
import { renderOutbound } from "../src/run/history";
import { makeCore } from "./harness";

function userMessage(text: string, parts: Message["parts"] = []): Message {
  return {
    id: "msg_1" as Message["id"],
    sessionId: "ses_1" as Message["sessionId"],
    role: "user",
    createdAt: "2026-01-01T00:00:00Z",
    parts: [{ id: "part_1" as Message["parts"][number]["id"], messageId: "msg_1" as Message["id"], ord: 0, kind: "text", payload: { text } }, ...parts],
  };
}

describe("expandMentions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-mentions-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
    writeFileSync(join(dir, "src", "bin.dat"), Buffer.from([1, 0, 2, 0]));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("expands a whole-file mention with numbered lines", () => {
    const { blocks } = expandMentions("read #src/a.txt please", dir, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.path).toBe("src/a.txt");
    expect(blocks[0]?.content).toContain("1: line 1");
    expect(blocks[0]?.content).toContain("20: line 20");
    expect(blocks[0]?.error).toBeUndefined();
  });

  test("slices an explicit line range", () => {
    const { blocks } = expandMentions("#src/a.txt:3-5", dir, []);
    expect(blocks[0]).toMatchObject({ path: "src/a.txt", from: 3, to: 5 });
    expect(blocks[0]?.content).toContain("3: line 3");
    expect(blocks[0]?.content).toContain("5: line 5");
    expect(blocks[0]?.content).not.toContain("6: line 6");
  });

  test("lists a directory mention", () => {
    const { blocks } = expandMentions("look at #src", dir, []);
    expect(blocks[0]?.path).toBe("src");
    expect(blocks[0]?.content).toContain("a.txt");
  });

  test("fails closed outside the workspace", () => {
    const { blocks } = expandMentions("#/etc/hosts", dir, []);
    expect(blocks[0]?.error).toBe(true);
    expect(blocks[0]?.content).toContain("outside this session's workspace");
  });

  test("reports a binary file instead of attaching it", () => {
    const { blocks } = expandMentions("#src/bin.dat", dir, []);
    expect(blocks[0]?.error).toBe(true);
    expect(blocks[0]?.content).toContain("binary");
  });

  test("returns no blocks without mentions", () => {
    expect(expandMentions("plain text", dir, []).blocks).toEqual([]);
  });
});

describe("renderOutbound file parts", () => {
  test("appends a <file> block after the user text", () => {
    const message: Message = {
      ...userMessage("see #src/a.txt"),
      parts: [
        { id: "p1" as never, messageId: "msg_1" as never, ord: 0, kind: "text", payload: { text: "see #src/a.txt" } },
        {
          id: "p2" as never,
          messageId: "msg_1" as never,
          ord: 1,
          kind: "file",
          payload: { path: "src/a.txt", from: 1, to: 2, content: "1: hello\n2: world" },
        },
      ],
    };
    const out = renderOutbound([message]);
    const content = out.at(-1)?.content;
    expect(typeof content).toBe("string");
    expect(content as string).toContain("see #src/a.txt");
    expect(content as string).toContain('<file path="src/a.txt" lines="1-2">');
    expect(content as string).toContain("1: hello");
  });

  test("renders an error block", () => {
    const message: Message = {
      ...userMessage("#missing"),
      parts: [
        { id: "p1" as never, messageId: "msg_1" as never, ord: 0, kind: "text", payload: { text: "#missing" } },
        {
          id: "p2" as never,
          messageId: "msg_1" as never,
          ord: 1,
          kind: "file",
          payload: { path: "missing", content: "File not found: /x/missing", error: true },
        },
      ],
    };
    const content = renderOutbound([message]).at(-1)?.content as string;
    expect(content).toContain('<file path="missing" error="true">');
    expect(content).toContain("File not found");
  });
});

describe("promotion expands mentions", () => {
  test("persists a file part for #path:from-to", async () => {
    const t = makeCore();
    const dir = mkdtempSync(join(tmpdir(), "bai-mention-run-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.txt"), "one\ntwo\nthree\n");
      const session = t.core.createSession({ workbench: "code", cwd: dir });
      t.core.submitPrompt(session.id, { text: "see #src/a.txt:2-3" });
      await t.core.drainNow(session.id);
      const user = t.core.history(session.id).find((m) => m.role === "user");
      const filePart = user?.parts.find((p) => p.kind === "file");
      expect(filePart).toBeDefined();
      const payload = filePart?.payload as { path?: string; from?: number; to?: number; content?: string };
      expect(payload.path).toBe("src/a.txt");
      expect(payload.from).toBe(2);
      expect(payload.to).toBe(3);
      expect(payload.content).toContain("2: two");
      expect(payload.content).not.toContain("1: one");
    } finally {
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
