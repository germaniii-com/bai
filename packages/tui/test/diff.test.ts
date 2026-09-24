import { describe, expect, test } from "bun:test";
import { diffStat } from "../src/state/diff";

describe("diffStat", () => {
  test("counts added/removed lines and extracts the file", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " export {};",
    ].join("\n");
    expect(diffStat(diff)).toEqual({ file: "src/foo.ts", added: 2, removed: 1 });
  });

  test("ignores the file headers when counting", () => {
    // `--- ` / `+++ ` must not be mistaken for -/+ change lines.
    const diff = ["--- a/x", "+++ b/x"].join("\n");
    expect(diffStat(diff)).toEqual({ file: "x", added: 0, removed: 0 });
  });

  test("a new file has no double slash and reports /dev/null source", () => {
    const diff = ["--- /dev/null", "+++ b/new.ts", "+hello"].join("\n");
    expect(diffStat(diff)).toEqual({ file: "new.ts", added: 1, removed: 0 });
  });
});
