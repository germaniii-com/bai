import { describe, expect, test } from "bun:test";
import type { Event, PlanFile } from "@bai/shared";
import { applyNotesEvent, applyPlansEvent } from "../src/state";

/** Build a minimal typed event without the discriminated-union ceremony. */
const evt = (type: string, payload: unknown, sessionId?: string): Event =>
  ({ seq: 1, type, ts: "t", payload, ...(sessionId !== undefined ? { sessionId } : {}) }) as unknown as Event;

describe("notes reducer (applyNotesEvent)", () => {
  test("notes.updated replaces the note wholesale (the editor sends the full body)", () => {
    expect(applyNotesEvent("old", evt("notes.updated", { notes: "new note" }, "ses_1"))).toBe("new note");
  });

  test("other events pass the note through unchanged", () => {
    expect(applyNotesEvent("keep", evt("run.started", {}))).toBe("keep");
  });
});

describe("plans reducer (applyPlansEvent)", () => {
  const plans: PlanFile[] = [
    { name: "refactor", bytes: 10, updatedAt: "2026-09-14T00:00:00Z" },
    { name: "research", bytes: 20, updatedAt: "2026-09-14T01:00:00Z" },
  ];

  test("plans.updated replaces the metadata list wholesale", () => {
    expect(applyPlansEvent([], evt("plans.updated", { plans }, "ses_1"))).toEqual(plans);
  });

  test("other events pass the list through by reference", () => {
    const current: PlanFile[] = [];
    expect(applyPlansEvent(current, evt("run.started", {}))).toBe(current);
  });
});
