import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PROVIDER_FILE_ID_RE,
  providerFileSchema,
  type ProviderFile,
} from "@bai/shared";
import { stripJsonComments } from "../config";
import { MEDIA_PROVIDER_SPECS } from "../media-providers";
import type { CatalogProvider, CatalogModel } from "./catalog";

/** One parsed provider file. */
export interface ResolvedProviderFile {
  id: string;
  file: ProviderFile;
  /** Absolute path of the defining file. */
  path: string;
}

export interface ProviderFileRegistryOpts {
  /** Directory scanned for provider files (`~/.config/bai/providers`). */
  dir: string;
  /** Watcher debounce; tests lower this. Default 150ms. */
  debounceMs?: number;
  /** Polling safety-net interval (fs.watch can miss events). 0 disables. Default 2000ms. */
  pollMs?: number;
  /** Fired after a rescan actually changed the effective provider set. */
  onChange?: () => void;
  /** Extra ids that may never be shadowed (built-in media ids are always reserved). */
  reservedIds?: Iterable<string>;
}

const FILE_RE = /\.(json|jsonc)$/i;

/** Built-in media adapter ids — files may not shadow them. */
function builtinReservedIds(): Set<string> {
  const out = new Set<string>(["stub"]);
  for (const spec of MEDIA_PROVIDER_SPECS) {
    out.add(spec.id);
    for (const alias of spec.aliases ?? []) out.add(alias);
  }
  return out;
}

/**
 * File-defined custom providers, hot-reloaded. Sibling of `McpRegistry`: a
 * debounced `fs.watch` + slow poll rescan `~/.config/bai/providers/` so a file
 * dropped in as `<id>.json` is live within ~150ms.
 *
 * Layering: files override `config.json` providers of the same id. Built-in
 * media adapter ids are reserved (a file trying to shadow one is ignored with a
 * warning). Invalid files are skipped — one bad file must never take down the
 * registry.
 */
export class ProviderFileRegistry {
  private files = new Map<string, ResolvedProviderFile>();
  private watcher: ReturnType<typeof watch> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private signature = "";
  private readonly debounceMs: number;
  private readonly reserved: Set<string>;

  constructor(private opts: ProviderFileRegistryOpts) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.reserved = new Set<string>([...builtinReservedIds(), ...(opts.reservedIds ?? [])]);
    mkdirSync(opts.dir, { recursive: true });
    this.scan();
    this.watchDir();
    const pollMs = opts.pollMs ?? 2000;
    if (pollMs > 0) {
      this.poller = setInterval(() => {
        if (this.scan() && this.opts.onChange) this.opts.onChange();
      }, pollMs);
      this.poller.unref?.();
    }
  }

  /** Rescan files; returns true when the effective provider set changed. */
  scan(): boolean {
    const next = new Map<string, ResolvedProviderFile>();
    let entries: string[] = [];
    try {
      entries = readdirSync(this.opts.dir)
        .filter((f) => FILE_RE.test(f))
        .sort();
    } catch {
      // Directory vanished mid-run: keep serving the previous set.
    }
    for (const entry of entries) {
      const full = path.join(this.opts.dir, entry);
      const stem = entry.replace(FILE_RE, "");
      let parsed: ReturnType<typeof parseProviderFile>;
      try {
        parsed = parseProviderFile(readFileSync(full, "utf8"), stem);
      } catch (err) {
        console.warn(`[bai] provider file ignored (unreadable): ${entry}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!parsed.ok) {
        console.warn(`[bai] provider file ignored (${parsed.error}): ${entry}`);
        continue;
      }
      const id = parsed.value.id ?? stem;
      if (this.reserved.has(id)) {
        console.warn(`[bai] provider file ignored, "${id}" is a reserved built-in id: ${entry}`);
        continue;
      }
      next.set(id, { id, file: parsed.value, path: full });
    }

    const signature = JSON.stringify(
      [...next.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => [id, r.file]),
    );
    const changed = signature !== this.signature;
    this.files = next;
    this.signature = signature;
    return changed;
  }

  get(id: string): ResolvedProviderFile | undefined {
    return this.files.get(id);
  }

  list(): ResolvedProviderFile[] {
    return [...this.files.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Absolute path of the JSON file that defines (or would define) `id`. */
  fileFor(id: string): string {
    return path.join(this.opts.dir, `${id}.json`);
  }

  /** Create or replace `~/.config/bai/providers/<id>.json`; surfaces are notified. */
  put(id: string, file: ProviderFile): ResolvedProviderFile {
    if (!PROVIDER_FILE_ID_RE.test(id)) throw new Error(`Invalid provider id: ${id}`);
    if (this.reserved.has(id)) throw new Error(`"${id}" is a reserved built-in provider id`);
    const parsed = providerFileSchema.safeParse({ ...file, id });
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; "));
    }
    const target = this.fileFor(id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`);
    renameSync(tmp, target);
    if (this.scan() && this.opts.onChange) this.opts.onChange();
    const resolved = this.get(id);
    if (resolved === undefined) throw new Error(`Provider file for "${id}" could not be read back`);
    return resolved;
  }

  /** Delete the file defining `id`. Returns false when no file exists. */
  remove(id: string): boolean {
    for (const ext of [".json", ".jsonc"]) {
      const target = path.join(this.opts.dir, `${id}${ext}`);
      if (!existsSync(target)) continue;
      rmSync(target);
      if (this.scan() && this.opts.onChange) this.opts.onChange();
      return true;
    }
    return false;
  }

  /** Translate files into catalog entries (env/base URL + capability flags). */
  catalogProviders(): CatalogProvider[] {
    return this.list().map(({ id, file, path }) => {
      const text = file.providerType.includes("text") ? file.text : undefined;
      const models: CatalogModel[] = (text?.models ?? []).map((modelId) => ({
        id: modelId,
        name: modelId,
        toolCall: true,
        reasoning: false,
        ...(text?.contextLength !== undefined ? { contextWindow: text.contextLength } : {}),
      }));
      return {
        id,
        name: file.name,
        npm: npmFor(text?.adapter),
        api: file.baseUrl,
        env: envFor(file),
        models,
        source: "file",
        mediaOnly: !file.providerType.includes("text"),
        providerType: file.providerType,
        filePath: path,
        ...(text !== undefined ? { adapter: text.adapter } : {}),
        ...(file.headers !== undefined ? { headers: file.headers } : {}),
      };
    });
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.poller !== undefined) clearInterval(this.poller);
    this.watcher?.close();
    this.watcher = undefined;
  }

  private watchDir(): void {
    try {
      this.watcher = watch(this.opts.dir, { recursive: true }, () => {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          if (this.scan() && this.opts.onChange) this.opts.onChange();
        }, this.debounceMs);
      });
    } catch (err) {
      console.warn(
        `[bai] provider hot-reload unavailable (${err instanceof Error ? err.message : err}); restart to pick up provider file changes`,
      );
    }
  }
}

/** Parse + validate one provider file (undefined-safe result). */
export function parseProviderFile(
  source: string,
  stem: string,
): { ok: true; value: ProviderFile } | { ok: false; error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonComments(source));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }
  const parsed = providerFileSchema.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ") };
  }
  if (!PROVIDER_FILE_ID_RE.test(parsed.data.id ?? stem)) {
    return { ok: false, error: `invalid provider id "${parsed.data.id ?? stem}"` };
  }
  return { ok: true, value: parsed.data };
}

function envFor(file: ProviderFile): string[] {
  if (file.env !== undefined && file.env.length > 0) return file.env;
  if (file.apiKeyEnv !== undefined) return [file.apiKeyEnv];
  return [];
}

function npmFor(adapter: string | undefined): string {
  switch (adapter) {
    case "anthropic":
      return "@ai-sdk/anthropic";
    case "openai":
      return "@ai-sdk/openai";
    case "responses":
      return "@ai-sdk/openai-responses";
    default:
      return "@ai-sdk/openai-compatible";
  }
}
