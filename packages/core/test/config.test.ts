import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigStore,
  findProjectConfig,
  loadConfig,
  stripJsonComments,
} from "../src";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bai-config-"));
}

describe("stripJsonComments", () => {
  test("strips // and /* */ but preserves strings", () => {
    const src = `{
      // line comment
      "url": "https://x//y", /* block */
      "a": 1
    }`;
    const parsed = JSON.parse(stripJsonComments(src));
    expect(parsed.url).toBe("https://x//y");
    expect(parsed.a).toBe(1);
  });
});

describe("loadConfig layering", () => {
  test("defaults → global → project → env → flags (later wins)", () => {
    const dir = tempDir();
    try {
      const globalPath = join(dir, "config.json");
      writeFileSync(globalPath, JSON.stringify({ models: { default: "global/model" }, permissions: { "fs.read": "allow" } }));

      const projectDir = join(dir, "project", ".bai");
      mkdirSync(projectDir, { recursive: true });
      const projectPath = join(projectDir, "config.json");
      writeFileSync(projectPath, JSON.stringify({ models: { default: "project/model" } }));
      const cwd = join(dir, "project");

      const { config, sources } = loadConfig({
        cwd,
        globalPath,
        env: { BAI_MODEL: "env/model" },
        flags: { models: { default: "flag/model" } },
      });

      expect(sources.global).toBe(globalPath);
      expect(sources.project).toBe(projectPath);
      expect(sources.env).toBe(true);
      expect(sources.flags).toBe(true);
      expect(config.models.default).toBe("flag/model"); // last layer wins
      expect(config.permissions["fs.read"]).toBe("allow"); // survives from global
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid layers are skipped (last-known-good)", () => {
    const dir = tempDir();
    try {
      const globalPath = join(dir, "config.json");
      writeFileSync(globalPath, "{ not json !!!");
      const { config, sources } = loadConfig({ cwd: dir, globalPath, env: {} });
      expect(sources.global).toBeUndefined();
      expect(config.models.default).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agents section: absent defaults to empty; present parses", () => {
    const dir = tempDir();
    try {
      const globalPath = join(dir, "config.json");
      const { config } = loadConfig({ cwd: dir, globalPath, env: {} });
      expect(config.agents).toEqual({});
      writeFileSync(globalPath, JSON.stringify({ agents: { default: "reviewer" } }));
      const loaded = loadConfig({ cwd: dir, globalPath, env: {} });
      expect(loaded.config.agents.default).toBe("reviewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("findProjectConfig walks up", () => {
    const dir = tempDir();
    try {
      const deep = join(dir, "a", "b", "c");
      mkdirSync(deep, { recursive: true });
      expect(findProjectConfig(deep)).toBeUndefined();
      const projectDir = join(dir, "a", ".bai");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "config.json"), "{}");
      expect(findProjectConfig(deep)).toBe(join(projectDir, "config.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ConfigStore write-back", () => {
  test("update merges into the global layer atomically and notifies", () => {
    const dir = tempDir();
    try {
      const globalPath = join(dir, "config.json");
      const seen: string[] = [];
      const store = new ConfigStore({ globalPath, cwd: dir, onChange: (c) => seen.push(c.models.default ?? "") });

      const updated = store.update({ models: { default: "stub/echo" } });
      expect(updated.models.default).toBe("stub/echo");
      expect(seen).toEqual(["stub/echo"]);

      // file contains the merged document
      const onDisk = JSON.parse(readFileSync(globalPath, "utf8"));
      expect(onDisk.models.default).toBe("stub/echo");
      expect(existsSync(globalPath)).toBe(true);

      // second update merges (does not clobber)
      store.update({ permissions: { "fs.read": "allow" } });
      const final = store.get();
      expect(final.models.default).toBe("stub/echo");
      expect(final.permissions["fs.read"]).toBe("allow");

      // agents.default merges the same way — later unrelated writes keep it.
      store.update({ agents: { default: "reviewer" } });
      expect(store.get().agents.default).toBe("reviewer");
      store.update({ models: { title: "small/model" } });
      expect(store.get().agents.default).toBe("reviewer");
      const onDiskAgents = JSON.parse(readFileSync(globalPath, "utf8"));
      expect(onDiskAgents.agents.default).toBe("reviewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
