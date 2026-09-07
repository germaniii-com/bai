import { describe, expect, test } from "bun:test";
import type { Event, Input } from "@bai/shared";
import { applyQueuedInputEvent, emptyQueuedInputs, queuedInputsFromSnapshot } from "../src/state/sync";

/** Build a minimal typed event without the discriminated-union ceremony. */
const evt = (type: string, payload: unknown, sessionId?: string): Event =>
  ({ seq: 1, type, ts: "2026-09-07T00:00:00Z", payload, ...(sessionId !== undefined ? { sessionId } : {}) }) as unknown as Event;

const queuedInput = (id: string): Input =>
  ({
    id,
    sessionId: "ses_1",
    payload: { text: `text ${id}`, queue: true },
    state: "admitted",
    queued: true,
    createdAt: "2026-09-07T00:00:00Z",
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
    state = applyQueuedInputEvent(state, evt("input.cancelled", { inputId: "i1" }, "ses_1"));
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
