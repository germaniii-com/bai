import { describe, expect, test } from "bun:test";
import { NAV_ITEMS, visibleNavIds } from "../src/nav-items";

describe("visibleNavIds", () => {
  test("basic mode keeps the workbenches only", () => {
    expect([...visibleNavIds(false, [])]).toEqual(["chat", "workspace", "image", "video"]);
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
});
