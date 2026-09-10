import { describe, expect, test } from "bun:test";
import type { SessionId } from "@bai/shared";
import { createApp } from "../src/server/app";
import { makeStack } from "./harness";

describe("attachments API", () => {
  test("upload stores bytes; submit carries the ref; content serves with nosniff", async () => {
    const stack = makeStack();
    try {
      const app = createApp(stack.deps);
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      const up = await app.request("/api/attachment", {
        method: "POST",
        headers: { "content-type": "image/png", "x-file-name": "pic.png" },
        body: bytes,
      });
      expect(up.status).toBe(201);
      const { attachment } = (await up.json()) as { attachment: { id: string; kind: string; name: string } };
      expect(attachment.kind).toBe("image");
      expect(attachment.name).toBe("pic.png");

      const sessionRes = await app.request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workbench: "chat" }),
      });
      const { session } = (await sessionRes.json()) as { session: { id: string } };

      const send = await app.request(`/api/session/${session.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "look", attachments: [attachment] }),
      });
      expect(send.status).toBe(202);

      // Let the wake's drain finish before cleanup closes the DB.
      await stack.core.drainNow(session.id as SessionId);

      const content = await app.request(`/api/asset/${attachment.id}/content`);
      expect(content.status).toBe(200);
      expect(content.headers.get("x-content-type-options")).toBe("nosniff");
      expect(content.headers.get("content-type")).toBe("image/png");
    } finally {
      stack.cleanup();
    }
  });

  test("rejects an unsupported binary upload", async () => {
    const stack = makeStack();
    try {
      const app = createApp(stack.deps);
      const res = await app.request("/api/attachment", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": "bin.dat" },
        body: new Uint8Array([1, 0, 2]),
      });
      expect(res.status).toBe(400);
    } finally {
      stack.cleanup();
    }
  });
});
