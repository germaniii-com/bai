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
 * A file may shadow a registered built-in under the same name (any name
 * shape — e.g. "fs.read.ts"); other dotted names are rejected. Deleting
 * the file restores the built-in (via `builtinFallback`).
 *
 * Bun caches dynamic imports by path and ignores `?query` busting (verified
 * empirically), and its resolver caches a directory's file listing — so a
 * changed file is copied to a FRESH import subdirectory (unique per import)
 * and the copy is imported instead. Expect tool files to rely on Bun/node
 * builtins —
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
  /**
   * Original built-in tool for a name, when one exists. Two uses:
   * - a dotted filename (e.g. "fs.read.ts") is accepted ONLY when this
   *   returns a tool for its stem — unknown dotted names stay rejected
   *   (impersonation guard);
   * - when an override file is removed, the fallback is re-registered so
   *   the built-in comes back instead of the name vanishing.
   */
  builtinFallback?: (name: string) => Tool | undefined;
}

interface Entry {
  /** Source file extension (".ts" or ".js"). */
  ext: string;
  /** Source file mtime at last import. */
  mtimeMs: number;
  /** The import directory holding the copied module (removed with the entry). */
  dir: string;
}

export class ToolLoader {
  private readonly entries = new Map<string, Entry>();
  /** Files already warned about as invalid names (warn once, not per poll). */
  private readonly warnedInvalid = new Set<string>();
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

    // Removed files → unregister; a shadowed built-in is restored from the
    // fallback snapshot so the name never vanishes.
    for (const [name, entry] of [...this.entries]) {
      const file = path.join(this.opts.dir, `${name}${entry.ext}`);
      if (!existsSync(file)) {
        const builtin = this.opts.builtinFallback?.(name);
        if (builtin !== undefined) this.opts.registry.register(builtin);
        else this.opts.registry.unregister(name);
        rmSync(entry.dir, { recursive: true, force: true });
        this.entries.delete(name);
        changed = true;
      }
    }

    for (const file of files) {
      const ext = path.extname(file);
      const name = path.basename(file, ext);
      // The stem is the tool name. Dots would let a file impersonate
      // namespaced tools ("fs.read"), so dotted stems are accepted ONLY
      // when they match a known built-in (a deliberate override) — via the
      // live registry OR the builtinFallback snapshot (which also covers
      // the boot race: the loader's first rescan can run before the
      // Service registers the built-ins, and a momentary gap after a
      // broken re-import dropped a registration). Every other dotted name
      // is ignored.
      const isBuiltin =
        this.opts.registry.get(name)?.origin === "builtin" ||
        this.opts.builtinFallback?.(name) !== undefined;
      if (!isValidToolName(name) && !isBuiltin) {
        // Warn once per file — the poller rescans every 2s and a repeating
        // warning is just log spam.
        if (!this.warnedInvalid.has(file)) {
          this.warnedInvalid.add(file);
          console.warn(`[bai] custom tool file ignored, invalid name: ${file}`);
        }
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

      // Each import gets a FRESH subdirectory. Bun's resolver caches a
      // directory's file listing, so a NEW copy added to an
      // already-imported directory can fail to resolve ("Cannot find
      // module") when imports happen in quick succession — the web save
      // flow hits this deterministically, and the failed import would
      // then retry forever. A unique directory per import sidesteps the
      // cache entirely and guarantees a never-before-seen module path, so
      // Bun also never serves a stale cached module for a re-imported
      // name. The directory is removed with the entry (and with stop()).
      const importDir = mkdtempSync(path.join(this.cacheDir, "i-"));
      try {
        const tool = await importToolFile(abs, name, ext, importDir);
        this.opts.registry.replace(tool);
        if (current !== undefined) rmSync(current.dir, { recursive: true, force: true });
        this.entries.set(name, { ext, mtimeMs, dir: importDir });
        changed = true;
      } catch (err) {
        rmSync(importDir, { recursive: true, force: true });
        console.warn(`[bai] custom tool skipped: ${file}: ${err instanceof Error ? err.message : err}`);
        if (current !== undefined) {
          // Changed file now fails to load — drop the old registration.
          this.opts.registry.unregister(name);
          rmSync(current.dir, { recursive: true, force: true });
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

/** Import one tool file (through a copy in a fresh import dir) and validate the contract. */
async function importToolFile(abs: string, name: string, ext: string, importDir: string): Promise<Tool> {
  const copy = path.join(importDir, `${name}${ext}`);
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

/**
 * Editable override template for a built-in tool, pre-filled with its real
 * description and schema (its literal source is not reliably available at
 * runtime — compiled builds). Saving this file shadows the built-in under
 * the same name; deleting the file restores the built-in registration.
 */
export function builtinOverrideTemplate(tool: Tool): string {
  const schema = JSON.stringify(tool.schema, null, 2).split("\n").join("\n  ");
  return `// Override of the built-in tool "${tool.name}".
// Saving this file replaces the built-in registration (hot, no restart);
// deleting the file restores the original built-in. The description and
// schema below are the built-in's — adjust them along with execute().
// Rely on Bun/node builtins — npm imports resolve from the config
// directory, not your workspace.

export default {
  description: ${JSON.stringify(tool.description)},
  schema: ${schema},
  async execute(args, ctx) {
    // ctx: { sessionId, cwd?, signal, emitLive }
    return { content: "override of ${tool.name} — implement me" };
  },
};
`;
}

