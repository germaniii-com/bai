import { describe, expect, test } from "bun:test";
import { budgetedLines, windowNumberedLines } from "../src/fs/window";

describe("windowNumberedLines", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

  test("never exceeds the budget and stops on a line boundary", () => {
    const w = windowNumberedLines(lines, { start: 1, maxLines: 100, budget: 40, lineCharCap: 2000 });
    expect(w.text.length).toBeLessThanOrEqual(40);
    expect(w.first).toBe(1);
    expect(w.last).toBe(3); // "1: line 1" + "2: line 2" + "3: line 3" = 29; line 4 pushes past 40
    expect(w.stoppedByBudget).toBe(true);
    expect(w.total).toBe(10);
  });

  test("an exact-fit budget keeps the boundary line", () => {
    const exact = "1: line 1\n2: line 2".length;
    const w = windowNumberedLines(lines, { start: 1, maxLines: 100, budget: exact, lineCharCap: 2000 });
    expect(w.last).toBe(2);
    expect(w.text).toBe("1: line 1\n2: line 2");
  });

  test("maxLines stops the window without claiming a budget cap", () => {
    const w = windowNumberedLines(lines, { start: 1, maxLines: 2, budget: 10_000, lineCharCap: 2000 });
    expect(w.last).toBe(2);
    expect(w.stoppedByBudget).toBe(false);
    expect(w.text).toBe("1: line 1\n2: line 2");
  });

  test("start offset resumes at the requested line", () => {
    const w = windowNumberedLines(lines, { start: 4, maxLines: 2, budget: 40, lineCharCap: 2000 });
    expect(w.text).toBe("4: line 4\n5: line 5");
    expect(w.first).toBe(4);
    expect(w.last).toBe(5);
  });

  test("a line longer than the whole budget is cut, never dropped", () => {
    const w = windowNumberedLines(["x".repeat(5_000)], {
      start: 1,
      maxLines: 10,
      budget: 200,
      lineCharCap: 5_000,
    });
    expect(w.text.length).toBeLessThanOrEqual(200);
    expect(w.lineTruncated).toBe(true);
    expect(w.last).toBe(1);
    expect(w.text).toContain("line truncated to fit the output budget");
    expect(w.stoppedByBudget).toBe(false); // this was the only line
  });

  test("per-line cap leaves an inline note and does not set lineTruncated", () => {
    const w = windowNumberedLines([`${"y".repeat(50)}`], { start: 1, maxLines: 10, budget: 1_000, lineCharCap: 10 });
    expect(w.lineCapped).toBe(true);
    expect(w.lineTruncated).toBe(false);
    expect(w.text).toContain("(line truncated to 10 chars)");
  });

  test("end of file reports no budget stop", () => {
    const w = windowNumberedLines(lines, { start: 8, maxLines: 100, budget: 10_000, lineCharCap: 2000 });
    expect(w.first).toBe(8);
    expect(w.last).toBe(10);
    expect(w.stoppedByBudget).toBe(false);
  });

  test("empty input yields an empty window", () => {
    const w = windowNumberedLines([], { start: 1, maxLines: 10, budget: 100, lineCharCap: 2000 });
    expect(w.text).toBe("");
    expect(w.last).toBeLessThan(w.first);
    expect(w.stoppedByBudget).toBe(false);
  });
});

describe("budgetedLines", () => {
  test("keeps what fits and flags the rest", () => {
    const { kept, truncated } = budgetedLines(["aaaa", "bbbb", "cccc"], 10);
    expect(kept).toEqual(["aaaa", "bbbb"]);
    expect(truncated).toBe(true);
  });

  test("always keeps the first entry even when it exceeds the budget", () => {
    const { kept, truncated } = budgetedLines(["z".repeat(100), "short"], 10);
    expect(kept).toEqual(["z".repeat(100)]);
    expect(truncated).toBe(true);
  });

  test("exact fit is not truncation", () => {
    const { kept, truncated } = budgetedLines(["aa", "bb"], 5);
    expect(kept).toEqual(["aa", "bb"]);
    expect(truncated).toBe(false);
  });
});
