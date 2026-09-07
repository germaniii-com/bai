import { describe, expect, test } from "bun:test";
import { parseRoute, routeToPath, wsSlug, wsUnslug } from "../src/router";

/** Round-trip helper: serialize → parse must return the original route. */
function roundTrip(route: ReturnType<typeof parseRoute>): void {
  expect(parseRoute(new URL(routeToPath(route), "http://x").pathname, new URL(routeToPath(route), "http://x").search)).toEqual(route);
}

describe("wsSlug / wsUnslug", () => {
  test("round-trips plain paths", () => {
    expect(wsUnslug(wsSlug("/Users/german/Projects/foo"))).toBe("/Users/german/Projects/foo");
  });
  test("round-trips paths with spaces and unicode", () => {
    const p = "/Users/german/My Projects/日本語/フォルダ";
    expect(wsUnslug(wsSlug(p))).toBe(p);
  });
  test("round-trips trailing slash and dots", () => {
    const p = "/home/g/work/bai.germaniii.com/";
    expect(wsUnslug(wsSlug(p))).toBe(p);
  });
  test("produces URL-safe characters only", () => {
    const slug = wsSlug("/Users/german/My Projects/x?y=z");
    expect(slug).toMatch(/^[A-Za-z0-9_-]*$/);
  });
  test("null on garbage, empty, and broken base64", () => {
    expect(wsUnslug("")).toBeNull();
    expect(wsUnslug("!!!not-base64!!!")).toBeNull();
    expect(wsUnslug("a")).toBeNull(); // 1 char → invalid after padding
  });
  test("null on empty-path slug (slug of \"\")", () => {
    expect(wsUnslug(wsSlug(""))).toBeNull();
  });
});

describe("parseRoute", () => {
  test("home and unknown paths fall back to the chat draft", () => {
    expect(parseRoute("/", "")).toEqual({ section: "chat", sessionId: null });
    expect(parseRoute("", "")).toEqual({ section: "chat", sessionId: null });
    expect(parseRoute("/nonsense/deep/path", "")).toEqual({ section: "chat", sessionId: null });
  });

  test("chat draft and session", () => {
    expect(parseRoute("/chat", "")).toEqual({ section: "chat", sessionId: null });
    expect(parseRoute("/chat/ses_01ABC", "")).toEqual({ section: "chat", sessionId: "ses_01ABC" });
    // extra segments → draft fallback
    expect(parseRoute("/chat/ses_01ABC/extra", "")).toEqual({ section: "chat", sessionId: null });
  });

  test("workspace picker, slug, view, session", () => {
    expect(parseRoute("/workspace", "")).toEqual({
      section: "workspace", wsPath: null, view: "chat", sessionId: null,
    });
    const path = "/Users/german/Projects/foo";
    const url = routeToPath({ section: "workspace", wsPath: path, view: "chat", sessionId: null });
    expect(parseRoute(new URL(url, "http://x").pathname, new URL(url, "http://x").search)).toEqual({
      section: "workspace", wsPath: path, view: "chat", sessionId: null,
    });
    const filesUrl = routeToPath({ section: "workspace", wsPath: path, view: "files", sessionId: "ses_01ABC" });
    expect(parseRoute(new URL(filesUrl, "http://x").pathname, new URL(filesUrl, "http://x").search)).toEqual({
      section: "workspace", wsPath: path, view: "files", sessionId: "ses_01ABC",
    });
  });

  test("workspace junk slug and empty w fall back to the picker", () => {
    expect(parseRoute("/workspace", "?w=!!!")).toEqual({
      section: "workspace", wsPath: null, view: "chat", sessionId: null,
    });
    expect(parseRoute("/workspace", "?w=")).toEqual({
      section: "workspace", wsPath: null, view: "chat", sessionId: null,
    });
  });

  test("workspace view=chat explicit and junk view fall back to chat view", () => {
    const path = "/tmp/w";
    const base = { section: "workspace" as const, wsPath: path, sessionId: null };
    const chatUrl = routeToPath({ ...base, view: "chat" });
    expect(parseRoute(new URL(chatUrl, "http://x").pathname, new URL(chatUrl, "http://x").search)).toMatchObject({ view: "chat" });
    // junk view param parses as chat view
    expect(parseRoute("/workspace", `?w=${wsSlug(path)}&view=nope`)).toMatchObject({ view: "chat" });
  });

  test("settings subsections; unknown → general", () => {
    expect(parseRoute("/settings", "")).toEqual({ section: "settings", settingsSection: "general" });
    expect(parseRoute("/settings/user", "")).toEqual({ section: "settings", settingsSection: "user" });
    expect(parseRoute("/settings/general", "")).toEqual({ section: "settings", settingsSection: "general" });
    expect(parseRoute("/settings/providers", "")).toEqual({ section: "settings", settingsSection: "providers" });
    expect(parseRoute("/settings/nope", "")).toEqual({ section: "settings", settingsSection: "general" });
  });

  test("agents and tools: list, new, detail; extra segments → list", () => {
    expect(parseRoute("/agents", "")).toEqual({ section: "agents", name: null, creating: false });
    expect(parseRoute("/agents/new", "")).toEqual({ section: "agents", name: null, creating: true });
    expect(parseRoute("/agents/coder", "")).toEqual({ section: "agents", name: "coder", creating: false });
    expect(parseRoute("/agents/coder/extra", "")).toEqual({ section: "agents", name: null, creating: false });
    expect(parseRoute("/tools", "")).toEqual({ section: "tools", name: null, creating: false });
    expect(parseRoute("/tools/new", "")).toEqual({ section: "tools", name: null, creating: true });
    expect(parseRoute("/tools/fs.read", "")).toEqual({ section: "tools", name: "fs.read", creating: false });
  });

  test("trailing slashes are harmless", () => {
    expect(parseRoute("/chat/", "")).toEqual({ section: "chat", sessionId: null });
    expect(parseRoute("/settings/providers/", "")).toEqual({ section: "settings", settingsSection: "providers" });
  });
});

describe("routeToPath", () => {
  test("round-trips every route shape", () => {
    roundTrip({ section: "chat", sessionId: null });
    roundTrip({ section: "chat", sessionId: "ses_01ABC" });
    roundTrip({ section: "workspace", wsPath: null, view: "chat", sessionId: null });
    roundTrip({ section: "workspace", wsPath: "/Users/german/My Projects/日本語", view: "files", sessionId: "ses_x" });
    roundTrip({ section: "settings", settingsSection: "user" });
    roundTrip({ section: "settings", settingsSection: "general" });
    roundTrip({ section: "settings", settingsSection: "providers" });
    roundTrip({ section: "agents", name: null, creating: false });
    roundTrip({ section: "agents", name: null, creating: true });
    roundTrip({ section: "agents", name: "coder", creating: false });
    roundTrip({ section: "tools", name: "fs.read", creating: false });
  });

  test("canonical shapes", () => {
    expect(routeToPath({ section: "chat", sessionId: null })).toBe("/chat");
    expect(routeToPath({ section: "chat", sessionId: "ses_01ABC" })).toBe("/chat/ses_01ABC");
    expect(routeToPath({ section: "workspace", wsPath: null, view: "chat", sessionId: null })).toBe("/workspace");
    expect(routeToPath({ section: "settings", settingsSection: "general" })).toBe("/settings/general");
    expect(routeToPath({ section: "agents", name: null, creating: true })).toBe("/agents/new");
    expect(routeToPath({ section: "tools", name: "fs.read", creating: false })).toBe("/tools/fs.read");
  });

  test("workspace slug is opaque in the URL (no raw path visible)", () => {
    const url = routeToPath({ section: "workspace", wsPath: "/Users/german/Projects/foo", view: "chat", sessionId: null });
    expect(url).toMatch(/^\/workspace\?w=[A-Za-z0-9_-]+$/);
    expect(url).not.toContain("/Users");
  });

  test("session ids with special characters are encoded", () => {
    const url = routeToPath({ section: "chat", sessionId: "ses/a b" });
    expect(url).toBe("/chat/ses%2Fa%20b");
    expect(parseRoute(new URL(url, "http://x").pathname, "")).toEqual({ section: "chat", sessionId: "ses/a b" });
  });
});
