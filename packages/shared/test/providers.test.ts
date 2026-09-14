import { describe, expect, test } from "bun:test";
import { suggestAccountId } from "../src/providers";

describe("suggestAccountId", () => {
  test("uses the base when free", () => {
    expect(suggestAccountId([], "work")).toBe("work");
    expect(suggestAccountId(["personal"], "work")).toBe("work");
  });

  test("increments past taken ids (case-insensitive)", () => {
    expect(suggestAccountId(["work"], "work")).toBe("work2");
    expect(suggestAccountId(["work", "work2"], "work")).toBe("work3");
    expect(suggestAccountId(["Work"], "work")).toBe("work2");
  });

  test("falls back to a generic base when none is given", () => {
    expect(suggestAccountId([])).toBe("account");
    expect(suggestAccountId(["account", "account2"])).toBe("account3");
  });
});
