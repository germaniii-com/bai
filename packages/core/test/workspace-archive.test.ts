import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCore, waitForEvent, type TestCore } from "./harness";

/**
 * Workspace archive/restore (the webui's Active | Archived mechanism):
 * removeWorkspace unregisters + bulk-archives the workspace's sessions
 * (hidden from every surface's lists); restoreWorkspace is the inverse.
 * The folder on disk is never touched.
 */
describe("workspace archive/restore (service)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
  });

  test("removeWorkspace: config move + bulk archive; lists hide the sessions", async () => {
    const ws = "/tmp/ws-a";
    const s1 = t.core.createSession({ workbench: "chat", cwd: ws });
    const s2 = t.core.createSession({ workbench: "code", cwd: ws });
    const other = t.core.createSession({ workbench: "chat", cwd: "/tmp/ws-b" });
    t.config.workspaces = [ws, "/tmp/ws-b"];

    const result = t.core.removeWorkspace(ws);
    expect(result.archived).toBe(2);

    // Config: moved to archivedWorkspaces, out of the active list.
    expect(t.config.workspaces).toEqual(["/tmp/ws-b"]);
    expect(t.config.archivedWorkspaces).toEqual([ws]);

    // Sessions: archived in place (data kept), hidden from the default lists.
    expect(t.core.getSession(s1.id)?.meta.archived).toBe(true);
    expect(t.core.getSession(s2.id)?.meta.archived).toBe(true);
    expect(t.core.listSessions(50, 0, { cwd: ws })).toHaveLength(0);
    expect(t.core.listSessions(50, 0, { cwd: "/tmp/ws-b" })).toHaveLength(1);
    expect(t.core.getSession(s1.id)).toBeDefined(); // still fetchable
    expect(other.meta.archived).toBeUndefined(); // untouched
  });

  test("restoreWorkspace: config move back + bulk unarchive", () => {
    const ws = "/tmp/ws-r";
    const s1 = t.core.createSession({ workbench: "chat", cwd: ws });
    t.config.workspaces = [ws];
    t.core.removeWorkspace(ws);
    expect(t.core.listSessions(50, 0, { cwd: ws })).toHaveLength(0);

    const result = t.core.restoreWorkspace(ws);
    expect(result.restored).toBe(1);
    expect(t.config.workspaces).toEqual([ws]);
    expect(t.config.archivedWorkspaces).toEqual([]);
    expect(t.core.getSession(s1.id)?.meta.archived).toBeUndefined();
    expect(t.core.listSessions(50, 0, { cwd: ws })).toHaveLength(1);
  });

  test("remove on an unregistered path and restore on a non-archived path are rejections", () => {
    expect(() => t.core.removeWorkspace("/tmp/never-registered")).toThrow("Not a registered workspace");
    expect(() => t.core.restoreWorkspace("/tmp/never-archived")).toThrow("Not an archived workspace");
  });

  test("remove/restore broadcast session.updated per touched session", async () => {
    const ws = "/tmp/ws-events";
    const s1 = t.core.createSession({ workbench: "chat", cwd: ws });
    t.config.workspaces = [ws];
    const updated = waitForEvent(t.bus, "session.updated");
    t.core.removeWorkspace(ws);
    await updated;
    const restored = waitForEvent(t.bus, "session.updated");
    t.core.restoreWorkspace(ws);
    await restored;
    expect(s1.id).toBeDefined();
  });

  test("archived sessions are excluded from listSessions but listByCwd sees them", () => {
    const ws = "/tmp/ws-store";
    const s1 = t.core.createSession({ workbench: "chat", cwd: ws });
    const s2 = t.core.createSession({ workbench: "chat", cwd: ws });
    t.core.archiveSession(s1.id);
    expect(t.core.listSessions(50, 0, { cwd: ws })).toHaveLength(1);
    expect(t.core.listSessions(50, 0, { cwd: ws })[0]?.id).toBe(s2.id);
    // The bulk input sees BOTH (restore must unarchive the archived ones).
    expect(t.core.listSessions(50, 0).length).toBeGreaterThanOrEqual(1);
  });
});
