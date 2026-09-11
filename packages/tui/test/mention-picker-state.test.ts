import { describe, expect, test } from "bun:test";
import { applyMention, expandMentionPaths, mentionDisplayToken, mentionTrigger, parseMentions, splitMentionQuery } from "@bai/shared";
import { browsedFolder, emptyMentionUi, moveMention, openedMention, selectedMention, withMentionResults } from "../src/state/mention";

/**
 * A folder that has children could never be referenced from the composer:
 * `applyMention` only ever *drilled into* a directory (`#dir/`, no trailing
 * space, picker stays open to keep filtering inside), so Enter always descended
 * one level. Directories get listed precisely because they have children, so
 * the parent folder was unreachable — you could mention files, never the folder.
 *
 * Fix: while browsing inside a folder the folder itself is offered as a
 * `dir-select` row, which routes through the insert path and produces a
 * terminal `#folder ` mention.
 */
describe("browsedFolder", () => {
  test("is the directory a trailing-slash query is browsing", () => {
    expect(browsedFolder("src/")).toBe("src");
    expect(browsedFolder("bai-ts/packages/")).toBe("bai-ts/packages");
    expect(browsedFolder("a//")).toBe("a");
  });

  test("is undefined for non-directory queries", () => {
    expect(browsedFolder("src/foo.ts")).toBeUndefined();
    expect(browsedFolder("src/foo.ts:10-20")).toBeUndefined();
    expect(browsedFolder("src")).toBeUndefined();
  });

  test("is undefined at the workspace root", () => {
    expect(browsedFolder("/")).toBeUndefined();
    expect(browsedFolder("")).toBeUndefined();
  });
});

describe("withMentionResults", () => {
  const browsing = (pathQuery: string) => withMentionResults(openedMention(pathQuery, pathQuery), []);

  test("offers the browsed folder as a selectable first row", () => {
    const state = withMentionResults(browsing("bai-ts/"), [
      { path: "bai-ts/packages", type: "dir" },
      { path: "bai-ts/README.md", type: "file" },
    ]);
    expect(state.results[0]).toEqual({ path: "bai-ts", type: "dir-select" });
    expect(state.results[1]?.path).toBe("bai-ts/packages");
    expect(state.results).toHaveLength(3);
  });

  test("lists the folder first so it is the default pick", () => {
    const state = withMentionResults(browsing("bai-ts/"), [{ path: "bai-ts/a.ts", type: "file" }]);
    expect(selectedMention(state)?.type).toBe("dir-select");
    expect(selectedMention(state)?.path).toBe("bai-ts");
  });

  test("re-types a result that already is that folder instead of duplicating it", () => {
    const state = withMentionResults(browsing("bai-ts/"), [
      { path: "bai-ts", type: "dir" },
      { path: "bai-ts/a.ts", type: "file" },
    ]);
    expect(state.results).toHaveLength(2);
    expect(state.results[0]).toEqual({ path: "bai-ts", type: "dir-select" });
  });

  test("a nested folder is selectable at any depth", () => {
    const state = withMentionResults(browsing("bai-ts/packages/"), []);
    expect(state.results[0]).toEqual({ path: "bai-ts/packages", type: "dir-select" });
  });

  test("adds nothing when the query is not a directory query", () => {
    const state = withMentionResults(browsing("bai-ts/pac"), [{ path: "bai-ts/packages", type: "dir" }]);
    expect(state.results).toEqual([{ path: "bai-ts/packages", type: "dir" }]);
  });

  test("adds nothing at the workspace root", () => {
    const state = withMentionResults(browsing(""), [{ path: "bai-ts", type: "dir" }]);
    expect(state.results).toEqual([{ path: "bai-ts", type: "dir" }]);
  });

  test("clears loading and keeps the selection in range", () => {
    const state = withMentionResults({ ...emptyMentionUi(), open: true, selected: 9, loading: true, pathQuery: "x/" }, []);
    expect(state.loading).toBe(false);
    expect(state.selected).toBe(0);
  });

  test("preserves the result order after the folder row", () => {
    const state = withMentionResults(browsing("s/"), [
      { path: "s/a.ts", type: "file" },
      { path: "s/b.ts", type: "file" },
    ]);
    expect(state.results.map((entry) => entry.path)).toEqual(["s", "s/a.ts", "s/b.ts"]);
  });
});

describe("moveMention", () => {
  test("wraps at both ends and is a no-op when empty", () => {
    const state = withMentionResults(browsing("s/"), [{ path: "s/a.ts", type: "file" }]);
    expect(moveMention(state, -1).selected).toBe(1);
    expect(moveMention(moveMention(state, 1), 1).selected).toBe(0);
    expect(moveMention(emptyMentionUi(), 1).selected).toBe(0);
  });
});

/**
 * The end-to-end contract: the `dir-select` row goes through the *insert*
 * branch (a `dir` row drills in instead), and the resulting leaf token expands
 * back to the folder's full path at submit — so the model is handed
 * `#bai-ts/packages`, which the server resolves as a directory.
 */
describe("selecting a folder with children, end to end", () => {
  /** Mirrors the chat view's insert branch for a non-`dir` row. */
  function selectRow(text: string, cursor: number, folderPath: string, taken: string[] = []) {
    const trigger = mentionTrigger(text, cursor);
    if (trigger === null) throw new Error("no active mention");
    const { range } = splitMentionQuery(trigger.raw);
    const token = mentionDisplayToken(folderPath, taken);
    const paths = { [token]: folderPath };
    const next = applyMention(text, cursor, trigger, { path: token, type: "file" }, range);
    return { next, outgoing: expandMentionPaths(next.text, paths) };
  }

  test("drilling in then taking the folder yields a terminal mention", () => {
    const drill = applyMention("#bai-ts", 7, mentionTrigger("#bai-ts", 7)!, { path: "bai-ts", type: "dir" });
    expect(drill.text).toBe("#bai-ts/");
    expect(drill.cursor).toBe(8);

    const state = withMentionResults(openedMention("bai-ts/", "bai-ts/"), [{ path: "bai-ts/packages", type: "dir" }]);
    const row = selectedMention(state)!;
    expect(row).toEqual({ path: "bai-ts", type: "dir-select" });

    const { next, outgoing } = selectRow(drill.text, drill.cursor, row.path);
    expect(next.text).toBe("#bai-ts ");
    expect(next.cursor).toBe(next.text.length);
    expect(mentionTrigger(next.text, next.cursor)).toBeNull();

    expect(outgoing).toBe("#bai-ts");
    expect(parseMentions(outgoing)).toEqual([{ path: "bai-ts" }]);
  });

  test("a deeply nested folder round-trips too", () => {
    const { next, outgoing } = selectRow("#bai-ts/packages/", 17, "bai-ts/packages", ["packages"]);
    expect(next.text.endsWith(" ")).toBe(true);
    expect(outgoing).toBe("#bai-ts/packages");
    expect(parseMentions(outgoing)[0]?.path).toBe("bai-ts/packages");
  });

  test("a folder range survives the round-trip", () => {
    const { outgoing } = selectRow("#src/:10", 7, "src", ["src"]);
    expect(outgoing).toBe("#src:10");
    expect(parseMentions(outgoing)[0]).toEqual({ path: "src", from: 10 });
  });
});
