import { describe, expect, test } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import type { Event, Input, Message, Session } from "@bai/shared";
import { applyEvent, argsDigest, applyQueuedInputEvent, emptyQueuedInputs, queuedInputsFromSnapshot, revertBoundary } from "../src/state";

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

describe("argsDigest (tool-node one-liner)", () => {
  test("skills.* nodes read the skill name (plus the linked file)", () => {
    expect(argsDigest("skills.view", JSON.stringify({ name: "research" }))).toBe("research");
    expect(argsDigest("skills.view", JSON.stringify({ name: "research", path: "references/api.md" }))).toBe(
      "research/references/api.md",
    );
    expect(argsDigest("skills.save", JSON.stringify({ name: "new-skill", description: "d" }))).toBe("new-skill");
  });

  test("non-skills tools keep the generic field chain", () => {
    expect(argsDigest("fs.read", JSON.stringify({ path: "src/x.ts" }))).toBe("src/x.ts");
    expect(argsDigest("bash", JSON.stringify({ command: "ls -la" }))).toBe("ls -la");
    // A skills tool without a name falls through to the generic digest.
    expect(argsDigest("skills.view", JSON.stringify({}))).toBe("");
  });
});

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

/** Build a minimal typed event without the discriminated-union ceremony. */
const evt = (type: string, payload: unknown, sessionId?: string): Event =>
  ({ seq: 1, type, ts: "t", payload, ...(sessionId !== undefined ? { sessionId } : {}) }) as unknown as Event;

const queuedInput = (id: string): Input =>
  ({
    id,
    sessionId: "ses_1",
    payload: { text: `text ${id}`, queue: true },
    state: "admitted",
    queued: true,
    createdAt: "t",
  }) as unknown as Input;

describe("queued-message reducer (applyQueuedInputEvent)", () => {
  test("admitted queued appends; steer admissions ignored", () => {
    let state = applyQueuedInputEvent(emptyQueuedInputs(), evt("input.admitted", { inputId: "i1", text: "one", queued: true }, "ses_1"));
    expect(state.inputs.map((i) => i.id as string)).toEqual(["i1"]);
    state = applyQueuedInputEvent(state, evt("input.admitted", { inputId: "i2", text: "two", queued: false }, "ses_1"));
    expect(state.inputs).toHaveLength(1); // steer admission never joins
  });

  test("send-now marks the node sending IN PLACE — no vanish gap", () => {
    let state = applyQueuedInputEvent(emptyQueuedInputs(), evt("input.admitted", { inputId: "i1", text: "one", queued: true }, "ses_1"));
    state = applyQueuedInputEvent(state, evt("input.updated", { inputId: "i1", queued: false }, "ses_1"));
    // The node STAYS in the list (rendered as "sending…") until promoted.
    expect(state.inputs.map((i) => i.id as string)).toEqual(["i1"]);
    expect(state.sendingIds).toEqual(["i1"]);
  });

  test("promoted/cancelled drop the node from both lists", () => {
    let state = applyQueuedInputEvent(emptyQueuedInputs(), evt("input.admitted", { inputId: "i1", text: "one", queued: true }, "ses_1"));
    state = applyQueuedInputEvent(state, evt("input.updated", { inputId: "i1", queued: false }, "ses_1"));
    state = applyQueuedInputEvent(state, evt("input.promoted", { inputId: "i1" }, "ses_1"));
    expect(state.inputs).toHaveLength(0);
    expect(state.sendingIds).toHaveLength(0);
  });

  test("duplicate admission (replay) and duplicate send-now are no-ops", () => {
    let state = applyQueuedInputEvent(emptyQueuedInputs(), evt("input.admitted", { inputId: "i1", text: "one", queued: true }, "ses_1"));
    state = applyQueuedInputEvent(state, evt("input.admitted", { inputId: "i1", text: "one", queued: true }, "ses_1"));
    expect(state.inputs).toHaveLength(1);
    state = applyQueuedInputEvent(state, evt("input.updated", { inputId: "i1", queued: false }, "ses_1"));
    state = applyQueuedInputEvent(state, evt("input.updated", { inputId: "i1", queued: false }, "ses_1"));
    expect(state.sendingIds).toEqual(["i1"]);
  });

  test("snapshot seed: queued + admitted-steer (sending) inputs", () => {
    const seeded = queuedInputsFromSnapshot([queuedInput("q1"), { ...queuedInput("s1"), queued: false }]);
    expect(seeded.inputs).toHaveLength(2);
    expect(seeded.sendingIds).toEqual(["s1"]);
    expect(queuedInputsFromSnapshot(undefined)).toEqual({ inputs: [], sendingIds: [] });
  });
});
