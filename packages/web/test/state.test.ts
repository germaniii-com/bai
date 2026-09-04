import { describe, expect, test } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import type { Event, Message, Session } from "@bai/shared";
import { applyEvent, revertBoundary } from "../src/state";

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
  test("drops only the removed message", () => {
    const { setMessages, get } = capture();
    applyEvent(setMessages, removedEvent("m9")); // no-op on empty
    const initial = [msg("m1", "user", "keep"), msg("m2", "assistant", "drop"), msg("m3", "user", "keep too")];
    for (const m of initial) setMessages((prev) => [...prev, m]);

    applyEvent(setMessages, removedEvent("m2"));
    expect(get().map((m) => m.id as string)).toEqual(["m1", "m3"]);

    applyEvent(setMessages, removedEvent("m2")); // duplicate removal is a no-op
    expect(get()).toHaveLength(2);
  });
});

describe("revertBoundary", () => {
  test("reads meta.revert.messageId; absent/malformed → undefined", () => {
    const withRevert = { meta: { revert: { messageId: "m2" } } } as unknown as Session;
    expect(revertBoundary(withRevert)).toBe("m2");
    expect(revertBoundary({ meta: {} } as unknown as Session)).toBeUndefined();
    expect(revertBoundary(null)).toBeUndefined();
    expect(revertBoundary({ meta: { revert: "junk" } } as unknown as Session)).toBeUndefined();
    expect(revertBoundary({ meta: { revert: { snapshot: "tree" } } } as unknown as Session)).toBeUndefined();
  });
});
