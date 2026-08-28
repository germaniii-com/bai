import { describe, expect, test } from "bun:test";
import { isPrefixed, newId, ulid, type SessionId } from "../src";

describe("ids", () => {
  test("prefixed ids have the right shape", () => {
    const ses = newId.session();
    expect(ses.startsWith("ses_")).toBe(true);
    expect(ses.length).toBe(4 + 26);
    expect(isPrefixed(ses, "ses")).toBe(true);
    expect(isPrefixed(ses, "msg")).toBe(false);
  });

  test("each aggregate gets its own prefix", () => {
    expect(newId.message().startsWith("msg_")).toBe(true);
    expect(newId.part().startsWith("part_")).toBe(true);
    expect(newId.input().startsWith("inp_")).toBe(true);
    expect(newId.run().startsWith("run_")).toBe(true);
    expect(newId.permissionRequest().startsWith("perm_")).toBe(true);
    expect(newId.job().startsWith("job_")).toBe(true);
    expect(newId.asset().startsWith("ast_")).toBe(true);
  });

  test("ulids are unique and time-sortable", () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).not.toBe(b);
    expect(a < b).toBe(true); // lexicographic order == time order
    const many = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(many.size).toBe(1000);
  });

  test("branded ids are strings at runtime", () => {
    const ses: SessionId = newId.session();
    expect(typeof ses).toBe("string");
  });
});
