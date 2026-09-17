import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, type TestCore } from "./harness";
import type { ToolContext } from "../src";

/**
 * `Service.executeToolCall` — the MCP server role's direct execution seam.
 * It must reuse the run loop's ToolContext + central permission gate so
 * `session.meta.autoApprove` and config rules behave identically.
 */
describe("Service.executeToolCall (MCP server role execution)", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-mcp-exec-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("autoApprove sessions run any tool through the gate", async () => {
    let seen: { sessionId: string; cwd?: string; agent?: string } | undefined;
    t.tools.register({
      name: "test.probe",
      description: "probe",
      schema: { type: "object", properties: {} },
      origin: "builtin",
      execute: async (_args: unknown, ctx: ToolContext) => {
        seen = {
          sessionId: ctx.sessionId,
          ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
          ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
        };
        return { content: "probe-ok" };
      },
    });
    const session = t.core.createSession({ workbench: "code", cwd: dir, meta: { autoApprove: true } });

    const result = await t.core.executeToolCall("test.probe", {}, { sessionId: session.id });
    expect(result.content).toBe("probe-ok");
    expect(seen?.sessionId).toBe(session.id);
    expect(seen?.cwd).toBe(dir);
    expect(seen?.agent).toBe("build");
  });

  test("config deny throws a permission error when not auto-approved", async () => {
    t.tools.register({
      name: "test.denied",
      description: "denied probe",
      schema: { type: "object", properties: {} },
      execute: async () => ({ content: "should not run" }),
    });
    t.config.permissions = { "test.denied": "deny" };
    const session = t.core.createSession({ workbench: "code" });

    await expect(t.core.executeToolCall("test.denied", {}, { sessionId: session.id })).rejects.toThrow(
      "Permission denied for tool: test.denied",
    );
  });

  test("autoApprove overrides a config deny (unattended run semantics)", async () => {
    t.tools.register({
      name: "test.override",
      description: "override probe",
      schema: { type: "object", properties: {} },
      execute: async () => ({ content: "ran" }),
    });
    t.config.permissions = { "test.override": "deny" };
    const session = t.core.createSession({ workbench: "code", meta: { autoApprove: true } });

    const result = await t.core.executeToolCall("test.override", {}, { sessionId: session.id });
    expect(result.content).toBe("ran");
  });

  test("read-only defaults stay allowed without autoApprove", async () => {
    writeFileSync(join(dir, "note.txt"), "hello");
    const session = t.core.createSession({ workbench: "code", cwd: dir });

    const result = await t.core.executeToolCall("fs.list", { path: "." }, { sessionId: session.id });
    expect(result.content).toContain("note.txt");
  });

  test("unknown tools and unknown sessions fail fast", async () => {
    const session = t.core.createSession({ workbench: "code", meta: { autoApprove: true } });
    await expect(t.core.executeToolCall("nope.nope", {}, { sessionId: session.id })).rejects.toThrow("Unknown tool: nope.nope");
    await expect(t.core.executeToolCall("fs.list", {}, { sessionId: "ses_missing" as never })).rejects.toThrow(
      "Unknown session: ses_missing",
    );
  });

  test("an emitted live event reaches the bus", async () => {
    t.tools.register({
      name: "test.emit",
      description: "emit probe",
      schema: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        ctx.emitLive("tools.updated", {});
        return { content: "emitted" };
      },
    });
    const session = t.core.createSession({ workbench: "code", meta: { autoApprove: true } });
    const sub = t.bus.subscribe();
    try {
      await t.core.executeToolCall("test.emit", {}, { sessionId: session.id });
      const types = sub.take().map((e) => e.type);
      expect(types).toContain("tools.updated");
    } finally {
      t.bus.unsubscribe(sub.id);
    }
  });
});
