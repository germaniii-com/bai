import { describe, expect, test } from "bun:test";
import type { Message, Part } from "@bai/shared";
import { attachmentMarkers } from "../src/state/sync";

function part(ord: number, kind: Part["kind"], payload: unknown): Part {
  return { id: `p${ord}` as Part["id"], messageId: "m1" as Message["id"], ord, kind, payload };
}

function msg(parts: Part[]): Message {
  return { id: "m1" as Message["id"], sessionId: "s1" as Message["sessionId"], role: "user", createdAt: "t", parts };
}

describe("TUI attachment markers", () => {
  test("renders image markers", () => {
    expect(
      attachmentMarkers(
        msg([
          part(0, "text", { text: "look" }),
          part(1, "attachment", { id: "ast_1", name: "p.png", mime: "image/png", bytes: 1, kind: "image" }),
          part(2, "attachment", { id: "ast_2", name: "q.webp", mime: "image/webp", bytes: 1, kind: "image" }),
        ]),
      ),
    ).toEqual(["[image: p.png]", "[image: q.webp]"]);
  });

  test("marks discipline-stubbed attachments as omitted", () => {
    expect(attachmentMarkers(msg([part(0, "attachment", { omitted: true, name: "old.png", kind: "image" })]))).toEqual([
      "[omitted: old.png]",
    ]);
  });

  test("no markers for text-only messages", () => {
    expect(attachmentMarkers(msg([part(0, "text", { text: "hi" })]))).toEqual([]);
  });
});
