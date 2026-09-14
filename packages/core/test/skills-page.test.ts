import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCore, type TestCore } from "./harness";

/**
 * Offset-paged skill browse (UI). `list()` stays the full agent-facing read;
 * `listPage` slices/filters it for the skills dialog.
 */
describe("SkillRegistry.listPage", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.skills.stop();
    t.store.close();
  });

  test("pages name-sorted with a next offset; filtering by name/description", () => {
    t.skills.put("alpha", { description: "First skill", body: "# alpha\n\nbody" });
    t.skills.put("bravo", { description: "Second skill", body: "# bravo\n\nbody" });
    t.skills.put("charlie", { description: "Third skill", body: "# charlie\n\nbody" });

    // The agent-facing full read is untouched.
    expect(t.core.listSkills().map((s) => s.name)).toEqual(["alpha", "bravo", "charlie"]);

    const first = t.core.listSkillsPage(2);
    expect(first.skills.map((s) => s.name)).toEqual(["alpha", "bravo"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(2);
    expect(first.total).toBe(3);

    const second = t.core.listSkillsPage(2, first.nextOffset);
    expect(second.skills.map((s) => s.name)).toEqual(["charlie"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextOffset).toBeUndefined();

    // Substring filter over description.
    expect(t.core.listSkillsPage(10, 0, "second").skills.map((s) => s.name)).toEqual(["bravo"]);
    // No match.
    expect(t.core.listSkillsPage(10, 0, "zzz").skills).toHaveLength(0);
  });
});
