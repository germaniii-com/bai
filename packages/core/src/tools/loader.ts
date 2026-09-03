import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isValidToolName } from "@bai/shared";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry";

/**
 * Custom tool files: `~/.config/bai/tools/*.ts|js`, hot-reloaded.
 *
 * Contract — a default (or named `tool`) export:
 *
 *   export default {
 *     description: "What the tool does (model-facing).",
 *     schema: { type: "object", properties: {...}, required: [...] },
 *     execute(args, ctx) { return { content: "..." }; },  // or a plain string
 *   }
 *
 * The tool NAME is the filename stem (agents use the same convention).
 * Built-in tools cannot be shadowed.
 *
 * Bun caches dynamic imports by path and ignores `?query` busting (verified
 * empirically), so a changed file is copied to a versioned temp file and the
 * copy is imported instead. Expect tool files to rely on Bun/node builtins —
 * npm imports resolve from the config dir, not the workspace (same trust
 * model as opencode plugins).
 */

export interface CustomToolDef {
  description?: unknown;
  name?: unknown;
  schema?: unknown;
  execute?: unknown;
}

export interface ToolLoaderOpts {
  dir: string;
  registry: ToolRegistry;
  debounceMs?: number;
  /** Polling safety-net interval (fs.watch misses events under load / on
   * some FSEvents setups). 0 disables. Default 2000ms. */
  pollMs?: number;
  onChange?: () => void;
}

interface Entry {
  /** Source file extension (".ts" or ".js"). */
  ext: string;
  /** Source file mtime at last import. */
  mtimeMs: number;
  /** Path of the imported (copied) module backing the registration. */
  copy: string;
}

export class ToolLoader {
  private readonly entries = new Map<string, Entry>();
  private watcher: ReturnType<typeof watch> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private cacheDir: string;
  private loading: Promise<boolean> = Promise.resolve(false);

  constructor(private opts: ToolLoaderOpts) {
    mkdirSync(opts.dir, { recursive: true });
    this.cacheDir = mkdtempSync(path.join(tmpdir(), "bai-tools-"));
    void this.rescan();
    this.watchDir();
    // Safety net: fs.watch can miss events under load (FSEvents latency) —
    // a slow rescan loop guarantees eventual hot-reload either way.
    const pollMs = opts.pollMs ?? 2000;
    if (pollMs > 0) {
      this.poller = setInterval(() => {
        void this.rescan().then((changed) => {
          if (changed && this.opts.onChange !== undefined) this.opts.onChange();
        });
      }, pollMs);
      this.poller.unref?.();
    }
  }

  /** Re-import new/changed files and unregister removed ones. Resolves when imports settle. */
  rescan(): Promise<boolean> {
    const next = this.loading.then(() => this.rescanNow());
    this.loading = next.catch(() => false);
    return next;
  }

  private async rescanNow(): Promise<boolean> {
    let files: string[] = [];
    try {
      files = readdirSync(this.opts.dir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    } catch {
      return false;
    }

    let changed = false;

    // Removed files → unregister.
    for (const [name, entry] of [...this.entries]) {
      const file = path.join(this.opts.dir, `${name}${entry.ext}`);
      if (!existsSync(file)) {
        this.opts.registry.unregister(name);
        rmSync(entry.copy, { force: true });
        this.entries.delete(name);
        changed = true;
      }
    }

    for (const file of files) {
      const ext = path.extname(file);
      const name = path.basename(file, ext);
      // The stem is the tool name — dots would impersonate namespaced
      // built-ins ("fs.read"), so they never register.
      if (!isValidToolName(name)) {
        console.warn(`[bai] custom tool file ignored, invalid name: ${file}`);
        continue;
      }
      const abs = path.join(this.opts.dir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        continue;
      }
      const current = this.entries.get(name);
      if (current !== undefined && current.mtimeMs === mtimeMs) continue;

      try {
        const tool = await importToolFile(abs, name, mtimeMs, ext, this.cacheDir);
        this.opts.registry.replace(tool);
        if (current !== undefined) rmSync(current.copy, { force: true });
        this.entries.set(name, { ext, mtimeMs, copy: toolCopyPath(this.cacheDir, name, mtimeMs, ext) });
        changed = true;
      } catch (err) {
        console.warn(`[bai] custom tool skipped: ${file}: ${err instanceof Error ? err.message : err}`);
        if (current !== undefined) {
          // Changed file now fails to load — drop the old registration.
          this.opts.registry.unregister(name);
          rmSync(current.copy, { force: true });
          this.entries.delete(name);
          changed = true;
        }
      }
    }

    return changed;
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.poller !== undefined) clearInterval(this.poller);
    this.watcher?.close();
    this.watcher = undefined;
    rmSync(this.cacheDir, { recursive: true, force: true });
  }

  /** The directory tool files are loaded from (CRUD writes land here). */
  dir(): string {
    return this.opts.dir;
  }

  private watchDir(): void {
    try {
      this.watcher = watch(this.opts.dir, { recursive: true }, () => {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.rescan().then((changed) => {
            if (changed && this.opts.onChange) this.opts.onChange();
          });
        }, this.opts.debounceMs ?? 150);
      });
    } catch (err) {
      console.warn(`[bai] tool hot-reload unavailable (${err instanceof Error ? err.message : err}); restart to pick up tool file changes`);
    }
  }
}

/** Import one tool file (through a versioned copy) and validate the contract. */
async function importToolFile(abs: string, name: string, mtimeMs: number, ext: string, cacheDir: string): Promise<Tool> {
  const copy = toolCopyPath(cacheDir, name, mtimeMs, ext);
  mkdirSync(path.dirname(copy), { recursive: true });
  copyFileSync(abs, copy);
  const mod = (await import(pathToFileURL(copy).href)) as Record<string, unknown>;
  const def = (mod.default ?? mod.tool) as CustomToolDef | undefined;
  if (def === undefined || typeof def !== "object") {
    throw new Error("no default (or `tool`) export found");
  }
  if (typeof def.execute !== "function") {
    throw new Error("export must define execute(args, ctx)");
  }
  if (typeof def.description !== "string" || def.description.length === 0) {
    throw new Error("export must define a description string");
  }
  const schema = validateSchema(def.schema);
  const execute = def.execute as (args: unknown, ctx: ToolContext) => Promise<ToolResult | string> | ToolResult | string;
  if (typeof def.name === "string" && def.name !== name) {
    console.warn(`[bai] custom tool ${name}: export name "${def.name}" ignored (filename stem wins)`);
  }
  return {
    name,
    description: def.description,
    schema,
    origin: "file",
    async execute(args, ctx) {
      const result = await execute(args, ctx);
      return typeof result === "string" ? { content: result } : result;
    },
  };
}

function toolCopyPath(cacheDir: string, name: string, mtimeMs: number, ext: string): string {
  return path.join(cacheDir, `${name}-${Math.floor(mtimeMs)}${ext}`);
}

function validateSchema(schema: unknown): Record<string, unknown> {
  if (schema === undefined || schema === null) return { type: "object", properties: {} };
  if (typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("schema must be a JSON Schema object");
  }
  return schema as Record<string, unknown>;
}

/** Template written when a surface creates a new custom tool from scratch. */
export function toolTemplate(name: string): string {  return `// Custom bai tool: ${name}
// The filename stem is the tool's name. Rely on Bun/node builtins —
// npm imports resolve from the config directory, not your workspace.
// After saving, the tool is hot-registered (no restart).

export default {
  description: "What ${name} does, phrased for the model.",
  schema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Describe this argument for the model." },
    },
    required: ["input"],
  },
  async execute(args, ctx) {
    const { input } = args as { input: string };
    // ctx: { sessionId, cwd?, signal, emitLive }
    return { content: \`you said: \${input}\` };
  },
};
`;
}

