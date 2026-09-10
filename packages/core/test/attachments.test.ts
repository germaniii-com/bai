import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { classifyAttachment, imageMimeFromName } from "../src/attachments";
import { makeCore } from "./harness";

describe("attachment classification", () => {
  test("images by extension or declared mime", () => {
    expect(classifyAttachment("a.png", "", new Uint8Array([1, 2, 3]))).toEqual({ kind: "image", mime: "image/png" });
    expect(classifyAttachment("a", "image/jpeg", new Uint8Array([1]))).toEqual({ kind: "image", mime: "image/jpeg" });
  });

  test("pdf by extension or mime", () => {
    expect(classifyAttachment("doc.pdf", "application/pdf", new Uint8Array([1]))).toEqual({ kind: "pdf", mime: "application/pdf" });
    expect(classifyAttachment("doc", "application/pdf", new Uint8Array([1]))).toEqual({ kind: "pdf", mime: "application/pdf" });
  });

  test("text is accepted when not binary", () => {
    expect(classifyAttachment("notes.md", "text/markdown", new TextEncoder().encode("# hi"))).toEqual({ kind: "text", mime: "text/markdown" });
  });

  test("binary non-media is rejected", () => {
    expect(() => classifyAttachment("bin.dat", "", new Uint8Array([1, 0, 2]))).toThrow(/Unsupported file type/);
  });

  test("imageMimeFromName detects images only", () => {
    expect(imageMimeFromName("x.webp")).toBe("image/webp");
    expect(imageMimeFromName("x.pdf")).toBeUndefined();
    expect(imageMimeFromName("x.txt")).toBeUndefined();
  });
});

describe("AttachmentStore (via Service)", () => {
  test("save stores bytes on disk and hands back a ref", () => {
    const t = makeCore();
    try {
      const bytes = new TextEncoder().encode("hello attachment");
      const ref = t.core.saveAttachment(bytes, "notes.txt", "text/plain");
      expect(ref.kind).toBe("text");
      expect(ref.mime).toBe("text/plain");
      expect(ref.bytes).toBe(bytes.byteLength);
      const path = t.core.attachmentPath(ref.id);
      expect(path).toBeDefined();
      expect(path).toContain("attachment");
      expect(t.core.attachments.data(ref.id)).toEqual(bytes);
      expect(t.core.attachments.ref(ref.id)?.name).toBe("notes.txt");
    } finally {
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("text over the 1 MB cap is rejected", () => {
    const t = makeCore();
    try {
      const big = new Uint8Array(1_000_001).fill(65);
      expect(() => t.core.saveAttachment(big, "big.txt", "text/plain")).toThrow(/too large/i);
    } finally {
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("promotion turns attachments into parts (text -> file, image/pdf -> attachment)", async () => {
    const t = makeCore();
    try {
      const textRef = t.core.saveAttachment(new TextEncoder().encode("line one\nline two"), "notes.txt", "text/plain");
      const imageRef = t.core.saveAttachment(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "pic.png", "image/png");
      const pdfRef = t.core.saveAttachment(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "doc.pdf", "application/pdf");
      const session = t.core.createSession({ workbench: "chat" });
      t.core.submitPrompt(session.id, { text: "look at these", attachments: [textRef, imageRef, pdfRef] });
      await t.core.drainNow(session.id);
      const user = t.core.history(session.id).find((m) => m.role === "user");
      const filePart = user?.parts.find((p) => p.kind === "file");
      const attachments = user?.parts.filter((p) => p.kind === "attachment") ?? [];
      expect(filePart).toBeDefined();
      expect((filePart?.payload as { assetId?: string }).assetId).toBe(textRef.id);
      expect((filePart?.payload as { content?: string }).content).toContain("1: line one");
      expect(attachments.map((p) => (p.payload as { kind?: string }).kind).sort()).toEqual(["image", "pdf"]);
    } finally {
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe("attachment capability check", () => {
  test("catalog-less models fail open (no known modality → allowed)", async () => {
    const t = makeCore();
    try {
      const session = t.core.createSession({ workbench: "chat" });
      const refs = [
        t.core.saveAttachment(new Uint8Array([1, 2, 3]), "a.png", "image/png"),
        t.core.saveAttachment(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "d.pdf", "application/pdf"),
        t.core.saveAttachment(new TextEncoder().encode("hi"), "n.txt", "text/plain"),
      ];
      await expect(t.core.assertAttachmentsSupported(session.id, refs)).resolves.toBeUndefined();
    } finally {
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
