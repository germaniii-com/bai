import { describe, expect, test } from "bun:test";
import {
  deriveFolderAliases,
  folderAliasMap,
  mergeExternalResults,
  registeredRoots,
  resolveAliasPath,
  resolveMentionAlias,
  sanitizeAlias,
} from "../src/workspace";

describe("sanitizeAlias", () => {
  test("collapses whitespace, strips # and separators, never empty", () => {
    expect(sanitizeAlias("My Docs")).toBe("My-Docs");
    expect(sanitizeAlias("a#b/c")).toBe("abc");
    expect(sanitizeAlias("   ")).toBe("folder");
  });
});

describe("deriveFolderAliases", () => {
  test("uses basenames and de-dupes against the main workspace and each other", () => {
    const aliases = deriveFolderAliases("/work/app", ["/other/app", "/other/app", "/x/docs"]);
    expect(aliases).toEqual([
      { alias: "app-2", path: "/other/app" },
      { alias: "app-3", path: "/other/app" },
      { alias: "docs", path: "/x/docs" },
    ]);
  });

  test("handles trailing slashes and spaces", () => {
    const aliases = deriveFolderAliases("/work/app", ["/tmp/My Docs/"]);
    expect(aliases).toEqual([{ alias: "My-Docs", path: "/tmp/My Docs/" }]);
  });

  test("empty extras → empty", () => {
    expect(deriveFolderAliases("/work/app", [])).toEqual([]);
  });

  test("folderAliasMap mirrors the derivation", () => {
    expect(folderAliasMap("/work/app", ["/other/app", "/x/docs"])).toEqual({
      "app-2": "/other/app",
      docs: "/x/docs",
    });
  });
});

describe("resolveMentionAlias", () => {
  const aliases = { repo: "/other/repo" };
  test("alias alone → the folder; alias/rel → joined; unknown → null", () => {
    expect(resolveMentionAlias("repo", aliases)).toBe("/other/repo");
    expect(resolveMentionAlias("repo/src/x.ts", aliases)).toBe("/other/repo/src/x.ts");
    expect(resolveMentionAlias("src/x.ts", aliases)).toBeNull();
  });
});

describe("resolveAliasPath", () => {
  test("maps an alias token back to root + rel", () => {
    expect(resolveAliasPath("/work/app", ["/other/repo"], "repo/src/x.ts")).toEqual({
      root: "/other/repo",
      rel: "src/x.ts",
    });
    expect(resolveAliasPath("/work/app", ["/other/repo"], "src/x.ts")).toBeNull();
  });
});

describe("mergeExternalResults", () => {
  test("main results lead; extras become alias/rel tokens; capped", () => {
    expect(
      mergeExternalResults(
        [{ path: "src/a.ts", type: "file" }, { path: "src", type: "dir" }],
        [{ alias: "repo", results: [{ path: "lib/b.ts", type: "file" }] }],
      ),
    ).toEqual([
      { path: "src/a.ts", type: "file" },
      { path: "src", type: "dir" },
      { path: "repo/lib/b.ts", type: "file" },
    ]);

    const many = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts`, type: "file" as const }));
    expect(mergeExternalResults(many, [], 30)).toHaveLength(30);
  });

  test("no extras → the main list is unchanged", () => {
    const main = [{ path: "a.ts", type: "file" as const }];
    expect(mergeExternalResults(main, [])).toEqual(main);
  });
});

describe("registeredRoots", () => {
  test("workspaces plus every extra, de-duplicated in order", () => {
    expect(
      registeredRoots(["/w/a", "/w/b"], { "/w/a": ["/x/one", "/w/b"], "/w/b": ["/x/two"] }),
    ).toEqual(["/w/a", "/w/b", "/x/one", "/x/two"]);
  });

  test("undefined map → workspaces only", () => {
    expect(registeredRoots(["/w/a"], undefined)).toEqual(["/w/a"]);
  });
});
