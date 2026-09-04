import { describe, expect, test } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import type { Event, Message, Session } from "@bai/shared";
import { applyEvent, buildTranscriptItems, revertBoundary } from "../src/state/sync";

/** Collect setMessages updates and expose the final list. */
function capture() {
  let messages: Message[] = [];
  const setMessages = ((update: (prev: Message[]) => Message[]) => {
    messages = update(messages);
  }) as Dispatch<SetStateAction<Message[]>>;
  return { setMessages, get: () => messages };
}

function msg(id: string, role: Message["role"], text: string): Message {
  return {
    id: id as Message["id"],
    sessionId: "ses_1" as Message["sessionId"],
    role,
    createdAt: "t",
    parts: [{ id: `${id}-p0` as Message["parts"][0]["id"], messageId: id as Message["id"], ord: 0, kind: "text", payload: { text } }],
  };
}

const removedEvent = (messageId: string): Event =>
  ({ seq: 1, ts: "t", type: "message.removed", payload: { messageId } }) as unknown as Event;

describe("message.removed reducer", () => {
  test("drops only the removed message (dedup tolerant)", () => {
    const { setMessages, get } = capture();
    applyEvent(setMessages, removedEvent("m9")); // no-op on empty
    for (const m of [msg("m1", "user", "keep"), msg("m2", "assistant", "drop"), msg("m3", "user", "keep too")]) {
      setMessages((prev) => [...prev, m]);
    }

    applyEvent(setMessages, removedEvent("m2"));
    expect(get().map((m) => m.id as string)).toEqual(["m1", "m3"]);

    applyEvent(setMessages, removedEvent("m2"));
    expect(get()).toHaveLength(2);
  });
});

describe("revertBoundary", () => {
  test("reads meta.revert.messageId; absent/malformed/null → undefined", () => {
    expect(revertBoundary({ meta: { revert: { messageId: "m2" } } } as unknown as Session)).toBe("m2");
    expect(revertBoundary({ meta: {} } as unknown as Session)).toBeUndefined();
    expect(revertBoundary(null)).toBeUndefined();
    expect(revertBoundary({ meta: { revert: "junk" } } as unknown as Session)).toBeUndefined();
  });
});

describe("transcript slicing at the revert boundary", () => {
  test("items built from the visible slice keep consistent message indexes", () => {
    const all = [
      msg("m1", "user", "kept prompt"),
      msg("m2", "assistant", "kept reply"),
      msg("m3", "user", "reverted prompt"),
      msg("m4", "assistant", "reverted reply"),
    ];
    const boundary = revertBoundary({ meta: { revert: { messageId: "m3" } } } as unknown as Session);
    const idx = all.findIndex((m) => m.id === boundary);
    const visible = all.slice(0, idx);

    const items = buildTranscriptItems(visible);
    // Every item resolves to a message inside the visible slice only.
    for (const item of items) {
      expect(visible[item.messageIndex]).toBeDefined();
      expect(item.messageId as string).toBe(visible[item.messageIndex]!.id as string);
    }
    expect(items.some((i) => i.messageId === "m3")).toBe(false);
    expect(items.some((i) => i.messageId === "m4")).toBe(false);
  });
});
