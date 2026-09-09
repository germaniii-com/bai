import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import {
  configPatchSchema,
  configSchema,
  deepMerge,
  DEFAULT_CONFIG,
  type Config,
  type ConfigPatch,
} from "@bai/shared";

/** Strip // and /* *​/ comments outside string literals (jsonc tolerance). */
export function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    const next = src[i + 1] as string | undefined;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++; // skip trailing '/'
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parse a JSON/JSONC file; undefined when missing or invalid (last-known-good wins). */
export function readJsoncFile(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(stripJsonComments(readFileSync(file, "utf8"))) as unknown;
  } catch {
    return undefined;
  }
}

/** Atomic write: temp file + rename. */
export function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Walk up from cwd looking for `.bai/config.json`. */
export function findProjectConfig(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".bai", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadedConfig {
  config: Config;
  sources: { defaults: true; global?: string; project?: string; env: boolean; flags: boolean };
}

export interface LoadConfigOptions {
  cwd: string;
  globalPath: string;
  flags?: ConfigPatch;
  env?: Record<string, string | undefined>;
}

/**
 * Layered load, later layers win (deep merge):
 * defaults → global file → project file (walk-up) → BAI_* env → flags.
 */
export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  let config: Config = structuredClone(DEFAULT_CONFIG);
  const sources: LoadedConfig["sources"] = { defaults: true, env: false, flags: false };

  const globalDoc = readJsoncFile(opts.globalPath);
  if (globalDoc !== undefined) {
    config = deepMerge(config, configPatchSchema.parse(globalDoc));
    sources.global = opts.globalPath;
  }

  const projectPath = findProjectConfig(opts.cwd);
  if (projectPath) {
    const doc = readJsoncFile(projectPath);
    if (doc !== undefined) {
      config = deepMerge(config, configPatchSchema.parse(doc));
      sources.project = projectPath;
    }
  }

  const env = opts.env ?? process.env;
  const envPatch: Record<string, unknown> = {};
  if (env.BAI_PORT !== undefined && env.BAI_PORT !== "") {
    (envPatch as { server?: Record<string, unknown> }).server = { port: Number(env.BAI_PORT) };
    sources.env = true;
  }
  if (env.BAI_TOKEN !== undefined && env.BAI_TOKEN !== "") {
    (envPatch as { server?: Record<string, unknown> }).server = {
      ...((envPatch as { server?: Record<string, unknown> }).server ?? {}),
      token: env.BAI_TOKEN,
    };
    sources.env = true;
  }
  if (env.BAI_MODEL !== undefined && env.BAI_MODEL !== "") {
    envPatch.models = { default: env.BAI_MODEL };
    sources.env = true;
  }
  if (sources.env) config = deepMerge(config, configPatchSchema.parse(envPatch));

  if (opts.flags && Object.keys(opts.flags).length > 0) {
    config = deepMerge(config, configPatchSchema.parse(opts.flags));
    sources.flags = true;
  }

  return { config: configSchema.parse(config), sources };
}

/**
 * Holds the effective config; mutations write back to the owning layer file
 * (v1: the global layer) atomically and notify via onChange.
 *
 * The global file is also WATCHED: another bai process (TUI ↔ `--web` run
 * side by side, each with its own ConfigStore over the same file) may write
 * it at any time — external changes reload live and fire onChange, so every
 * surface sees cross-process config edits without a restart (the same
 * hot-reload contract as the agent/skill registries). Own writes are
 * suppressed by a content signature: update() records the new signature
 * before onChange, so the watcher's later fire sees no diff.
 */
export class ConfigStore {
  private current: Config;
  private signature: string;
  private watcher: ReturnType<typeof watch> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private readonly debounceMs: number;

  constructor(
    private opts: {
      globalPath: string;
      cwd: string;
      onChange?: (config: Config) => void;
      /** Watcher debounce; tests lower this. Default 150ms. */
      debounceMs?: number;
      /** Polling safety-net interval (fs.watch misses events under load /
       * atomic-rename swaps). 0 disables. Default 2000ms. */
      pollMs?: number;
    },
  ) {
    this.current = loadConfig({ cwd: opts.cwd, globalPath: opts.globalPath }).config;
    this.signature = JSON.stringify(this.current);
    this.debounceMs = opts.debounceMs ?? 150;
    this.watchFile();
    // Safety net: fs.watch can miss events under load, and the atomic write
    // (tmp + rename) swaps the file's identity on some platforms — a slow
    // rescan loop guarantees eventual reload either way.
    const pollMs = opts.pollMs ?? 2000;
    if (pollMs > 0) {
      this.poller = setInterval(() => {
        this.rescan();
      }, pollMs);
      this.poller.unref?.();
    }
  }

  get(): Config {
    return this.current;
  }

  /** Merge a patch into the global layer file, reload, notify. */
  update(patch: ConfigPatch): Config {
    const existing = readJsoncFile(this.opts.globalPath) ?? {};
    const merged = deepMerge(
      {} as Record<string, unknown>,
      deepMerge(configPatchSchema.parse(existing) as Record<string, unknown>, patch as Record<string, unknown>),
    );
    atomicWriteJson(this.opts.globalPath, merged);
    this.current = loadConfig({ cwd: this.opts.cwd, globalPath: this.opts.globalPath }).config;
    // Record the signature BEFORE onChange: the watcher fires on our own
    // write too, and its rescan must see no diff (onChange is the single
    // broadcast — this call).
    this.signature = JSON.stringify(this.current);
    this.opts.onChange?.(this.current);
    return this.current;
  }

  /**
   * Reload the global file; fires onChange when the effective config
   * actually changed (signature-diffed — external edits only). A file that
   * exists but fails to parse (hand-edit typo, half-write) keeps the
   * last-known-good config — a broken layer must never wipe the effective
   * config at runtime. Public for tests.
   */
  rescan(): boolean {
    try {
      if (existsSync(this.opts.globalPath) && readJsoncFile(this.opts.globalPath) === undefined) {
        return false; // unparseable layer — keep serving the previous config
      }
      const reloaded = loadConfig({ cwd: this.opts.cwd, globalPath: this.opts.globalPath }).config;
      const signature = JSON.stringify(reloaded);
      if (signature === this.signature) return false;
      this.current = reloaded;
      this.signature = signature;
      this.opts.onChange?.(this.current);
      return true;
    } catch {
      return false; // schema-invalid layer — keep serving the previous config
    }
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.poller !== undefined) clearInterval(this.poller);
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Watch the config file's PARENT directory (not the file itself): the
   * atomic write replaces the file by rename, which can detach a file-level
   * watcher on some platforms. Any event in the dir triggers a debounced
   * rescan; the signature check makes unrelated events no-ops.
   */
  private watchFile(): void {
    try {
      this.watcher = watch(path.dirname(this.opts.globalPath), (event, filename) => {
        if (filename !== undefined && path.basename(this.opts.globalPath) !== filename) return;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.rescan(), this.debounceMs);
      });
    } catch (err) {
      console.warn(`[bai] config hot-reload unavailable (${err instanceof Error ? err.message : err}); restart to pick up external config changes`);
    }
  }
}
