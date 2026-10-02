import { describe, expect, test } from "bun:test";
import { NAV_ITEMS, visibleNavIds } from "../src/nav-items";

describe("visibleNavIds", () => {
  test("basic mode keeps the workbenches only", () => {
    expect([...visibleNavIds(false, [])]).toEqual(["bot", "chat", "workspace", "image", "video"]);
  });

  test("advanced mode shows every item", () => {
    expect(visibleNavIds(true).size).toBe(NAV_ITEMS.length);
  });

  test("hiddenNav drops items in either mode", () => {
    const advanced = visibleNavIds(true, ["automations", "video"]);
    expect(advanced.has("automations")).toBe(false);
    expect(advanced.has("video")).toBe(false);
    expect(advanced.has("agents")).toBe(true);

    const basic = visibleNavIds(false, ["workspace"]);
    expect(basic.has("workspace")).toBe(false);
    expect(basic.has("chat")).toBe(true);
  });

  test("bot leads the rail and is never advanced-gated", () => {
    expect(NAV_ITEMS[0]).toEqual({ id: "bot", label: "Bot", advanced: false });
    // Always visible: basic mode still reaches it.
    expect(visibleNavIds(false).has("bot")).toBe(true);
    // Hideable like any other item.
    expect(visibleNavIds(false, ["bot"]).has("bot")).toBe(false);
    expect(visibleNavIds(true, ["bot"]).has("bot")).toBe(false);
  });
});
