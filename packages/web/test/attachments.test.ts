import { describe, expect, test } from "bun:test";
import type { Message, Part } from "@bai/shared";
import { formatBytes, messageAttachments, messageTextAttachments } from "../src/attachments";

function part(ord: number, kind: Part["kind"], payload: unknown): Part {
  return { id: `p${ord}` as Part["id"], messageId: "m1" as Message["id"], ord, kind, payload };
}

function msg(parts: Part[]): Message {
  return { id: "m1" as Message["id"], sessionId: "s1" as Message["sessionId"], role: "user", createdAt: "t", parts };
}

describe("web attachment selectors", () => {
  test("collects image/pdf attachment parts", () => {
    const out = messageAttachments(
      msg([
        part(0, "text", { text: "look" }),
        part(1, "attachment", { id: "ast_1", name: "p.png", mime: "image/png", bytes: 1234, kind: "image" }),
        part(2, "attachment", { id: "ast_2", name: "d.pdf", mime: "application/pdf", bytes: 99, kind: "pdf" }),
      ]),
    );
    expect(out.map((a) => a.id)).toEqual(["ast_1", "ast_2"]);
    expect(out[1]?.kind).toBe("pdf");
  });

  test("ignores malformed attachment payloads", () => {
    expect(messageAttachments(msg([part(0, "attachment", { name: "x" })]))).toEqual([]);
  });

  test("collects text attachments carried on file parts", () => {
    const out = messageTextAttachments(
      msg([
        part(0, "file", { path: "notes.txt", content: "1: hi", assetId: "ast_9", mime: "text/plain" }),
        part(1, "file", { path: "src/a.ts", content: "1: x" }),
      ]),
    );
    expect(out).toEqual([{ id: "ast_9", name: "notes.txt" }]);
  });

  test("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
