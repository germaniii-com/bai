import { describe, expect, test } from "bun:test";
import type { Event, PermissionRequest } from "@bai/shared";
import { applyPermissionEvent } from "../src/state/sync";

/** Build a minimal typed event without the discriminated-union ceremony. */
const evt = (type: string, payload: unknown, sessionId?: string): Event =>
  ({ seq: 1, type, ts: "2026-09-02T00:00:00Z", payload, ...(sessionId !== undefined ? { sessionId } : {}) }) as unknown as Event;

const request = (id: string): PermissionRequest =>
  ({ id, tool: "fs.write", argsDigest: "abc", status: "pending", createdAt: "2026-09-02T00:00:00Z" }) as unknown as PermissionRequest;

describe("pending permission queue (applyPermissionEvent)", () => {
  test("asked appends, replied removes", () => {
    let list = applyPermissionEvent([], evt("permission.asked", { request: request("p1") }));
    expect(list.map((r) => r.id as string)).toEqual(["p1"]);
    list = applyPermissionEvent(list, evt("permission.asked", { request: request("p2") }));
    expect(list.map((r) => r.id as string)).toEqual(["p1", "p2"]);
    list = applyPermissionEvent(list, evt("permission.replied", { requestId: "p1", status: "approved" }));
    expect(list.map((r) => r.id as string)).toEqual(["p2"]);
  });

  test("duplicate ask (reconnect replay) is deduped", () => {
    let list = applyPermissionEvent([], evt("permission.asked", { request: request("p1") }));
    list = applyPermissionEvent(list, evt("permission.asked", { request: request("p1") }));
    expect(list).toHaveLength(1);
  });

  test("unrelated events pass the list through unchanged", () => {
    const list = [request("p1")];
    expect(applyPermissionEvent(list, evt("message.created", {}, "ses_x"))).toBe(list);
    expect(applyPermissionEvent(list, evt("run.started", {}))).toBe(list);
  });
});
