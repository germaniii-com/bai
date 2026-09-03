import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../src";

function makeStore(): { store: AuthStore; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bai-auth-"));
  const file = join(dir, "auth.json");
  return { store: new AuthStore({ file }), file, dir };
}

describe("AuthStore (multi-account credentials)", () => {
  test("set → list → get: projections never contain keys", () => {
    const { store, dir } = makeStore();
    store.set("openai", "personal", { label: "Personal", key: "sk-secret-1" });
    store.set("openai", "work", { label: "Work", key: "sk-secret-2", baseUrl: "https://proxy.example.com/v1" });

    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.id).sort()).toEqual(["personal", "work"]);
    for (const account of all) {
      expect(JSON.stringify(account)).not.toContain("sk-secret");
      expect(account.hasKey).toBe(true);
      expect(account.source).toBe("api");
    }
    const work = store.get("openai", "work");
    expect(work?.baseUrl).toBe("https://proxy.example.com/v1");
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists to disk with 0600 and reloads", () => {
    const { store, file, dir } = makeStore();
    store.set("anthropic", "main", { label: "Main", key: "sk-ant-secret" });
    expect(existsSync(file)).toBe(true);
    // 0o600 → no group/other bits
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toContain("sk-ant-secret");

    const reloaded = new AuthStore({ file });
    expect(reloaded.list("anthropic")).toHaveLength(1);
    expect(reloaded.resolve("anthropic", "main")?.apiKey).toBe("sk-ant-secret");
    rmSync(dir, { recursive: true, force: true });
  });

  test("upsert keeps unspecified fields; remove deletes", () => {
    const { store, dir } = makeStore();
    store.set("openai", "a", { label: "A", key: "k1", baseUrl: "https://x.example.com" });
    store.set("openai", "a", { key: "k2" }); // upsert: label + baseUrl survive
    const resolved = store.resolve("openai", "a");
    expect(resolved?.apiKey).toBe("k2");
    expect(resolved?.baseUrl).toBe("https://x.example.com");

    expect(store.remove("openai", "a")).toBe(true);
    expect(store.remove("openai", "a")).toBe(false);
    expect(store.resolve("openai", "a")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolve without accountId falls back to the first stored account", () => {
    const { store, dir } = makeStore();
    expect(store.resolve("openai")).toBeUndefined();
    store.set("openai", "b-second", { key: "kb" });
    store.set("openai", "a-first", { key: "ka" });
    // list() sorts by id → "a-first" is first
    expect(store.resolve("openai")?.accountId).toBe("a-first");
    expect(store.resolve("openai")?.apiKey).toBe("ka");
    rmSync(dir, { recursive: true, force: true });
  });

  test("set without any key (and none stored) throws", () => {
    const { store, dir } = makeStore();
    expect(() => store.set("openai", "x", { label: "no key" })).toThrow(/no API key/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("corrupt file starts empty instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-auth-"));
    const file = join(dir, "auth.json");
    require("node:fs").writeFileSync(file, "{not json");
    const store = new AuthStore({ file });
    expect(store.list()).toHaveLength(0);
    store.set("openai", "fresh", { key: "k" }); // next write replaces the file
    expect(store.list()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
