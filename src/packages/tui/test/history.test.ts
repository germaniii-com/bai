import { beforeEach, describe, expect, test } from "bun:test";
import { clearHistory, recordPrompt, resetTraversal, traverse } from "../src/state/history";

beforeEach(() => {
  clearHistory();
});

describe("prompt history", () => {
  test("empty history: traversal is a no-op", () => {
    expect(traverse(true, "draft")).toBeNull();
    expect(traverse(false, "draft")).toBeNull();
  });

  test("up walks newest → oldest, saving the draft on entry", () => {
    recordPrompt("a");
    recordPrompt("b");
    expect(traverse(true, "draft")).toBe("b");
    expect(traverse(true, "draft")).toBe("a");
    expect(traverse(true, "draft")).toBe("a"); // pinned at the oldest
  });

  test("down walks back and restores the saved draft past the newest", () => {
    recordPrompt("a");
    recordPrompt("b");
    expect(traverse(true, "my draft")).toBe("b");
    expect(traverse(true, "my draft")).toBe("a");
    expect(traverse(false, "")).toBe("b");
    expect(traverse(false, "")).toBe("my draft"); // draft restored
    expect(traverse(false, "")).toBeNull(); // already at the live draft
  });

  test("consecutive duplicates collapse", () => {
    recordPrompt("a");
    recordPrompt("a");
    recordPrompt("a");
    recordPrompt("b");
    recordPrompt("b");
    expect(traverse(true, "")).toBe("b");
    expect(traverse(true, "")).toBe("a");
    expect(traverse(true, "")).toBe("a"); // oldest — only one "a" stored
  });

  test("submitting a recalled entry re-records it (dedupe keeps order sane)", () => {
    recordPrompt("a");
    recordPrompt("b");
    expect(traverse(true, "")).toBe("b");
    recordPrompt("b"); // resubmitted after editing/traversal
    expect(traverse(true, "")).toBe("b");
    expect(traverse(true, "")).toBe("a");
  });

  test("resetTraversal returns to the live-draft boundary", () => {
    recordPrompt("a");
    expect(traverse(true, "draft")).toBe("a");
    resetTraversal();
    expect(traverse(false, "")).toBeNull(); // at the draft again
    expect(traverse(true, "draft2")).toBe("a"); // draft2 saved on re-entry
    expect(traverse(false, "")).toBe("draft2");
  });

  test("history is capped at 500 entries (oldest dropped)", () => {
    for (let i = 1; i <= 505; i++) recordPrompt(String(i));
    // 505 recorded, 500 kept → newest survivor "505", oldest survivor "6".
    expect(traverse(true, "draft")).toBe("505");
    for (let i = 0; i < 499; i++) traverse(true, "draft"); // walk to the oldest
    expect(traverse(true, "draft")).toBe("6"); // pinned at the oldest survivor
  });

  test("empty prompts are never recorded", () => {
    recordPrompt("");
    expect(traverse(true, "")).toBeNull();
  });
});
