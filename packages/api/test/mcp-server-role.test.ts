import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("GET /api/mcp/server-role", () => {
  let stack: TestStack | undefined;

  afterEach(async () => {
    if (stack !== undefined) await stack.cleanup();
    stack = undefined;
  });

  test("reports the live server-role status (enabled, counts, transport)", async () => {
    stack = makeStack();
    const app = createApp(stack.deps);

    const initial = await app.request("/api/mcp/server-role");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ enabled: false, transport: "streamable-http", skills: 0 });

    stack.deps.configStore.update({ mcpServer: { enabled: true } });
    stack.core.putSkill("demo", { description: "A demo skill.", body: "# Demo" });
    stack.core.createSession({ title: "one" });

    const next = await app.request("/api/mcp/server-role");
    const body = (await next.json()) as {
      enabled: boolean;
      tools: number;
      skills: number;
      sessions: number;
      transport: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.tools).toBeGreaterThan(0);
    expect(body.skills).toBe(1);
    expect(body.sessions).toBeGreaterThanOrEqual(1);
    expect(body.transport).toBe("streamable-http");
  });
});
