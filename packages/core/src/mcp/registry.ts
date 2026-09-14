import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  interpolateEnv,
  isValidMcpServerName,
  mcpServerFileSchema,
  type Config,
  type MCPServerConfig,
  type McpServerSource,
} from "@bai/shared";

/** A resolved MCP server: its definition plus where it came from. */
export interface ResolvedMcpServer {
  name: string;
  config: MCPServerConfig;
  source: McpServerSource;
  /** Absolute path of the defining file (file-sourced only). */
  path?: string;
}

export interface McpRegistryOpts {
  /** Directory scanned for MCP server files (`~/.config/bai/mcp`). */
  dir: string;
  /** Live config accessor — `config.json`'s `mcp` map is the lower layer. */
  config(): Config;
  /** Watcher debounce; tests lower this. Default 150ms. */
  debounceMs?: number;
  /** Polling safety-net interval (fs.watch can miss events). 0 disables. Default 2000ms. */
  pollMs?: number;
  /** Fired after a rescan actually changed the effective server set. */
  onChange?: () => void;
}

const MCP_FILE_RE = /\.(json|ya?ml)$/i;

/**
 * File-defined MCP servers, hot-reloaded. Sibling of `AgentRegistry`: a
 * debounced `fs.watch` + slow poll rescan `~/.config/bai/mcp/` so a server
 * dropped in as `<name>.json` (or `.yaml`) is live within ~150ms.
 *
 * One file defines one server (name = filename stem) — or several via a
 * `{ "mcpServers": { ... } }` wrapper (keys become names), which makes it
 * possible to drop in a Claude/opencode-style config verbatim.
 *
 * Layering: `config.json`'s `mcp` map is the programmatic layer; file-defined
 * servers OVERRIDE same-named config entries. Invalid files are skipped with a
 * warning — one bad file must never take down the registry.
 */
export class McpRegistry {
  private servers = new Map<string, ResolvedMcpServer>();
  private watcher: ReturnType<typeof watch> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private signature = "";
  private readonly debounceMs: number;

  constructor(private opts: McpRegistryOpts) {
    this.debounceMs = opts.debounceMs ?? 150;
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

  /** Rescan files + config; returns true when the effective server set changed. */
  scan(): boolean {
    const next = new Map<string, ResolvedMcpServer>();

    // Lower layer: config.json's mcp map.
    for (const [name, config] of Object.entries(this.opts.config().mcp ?? {})) {
      if (!isValidMcpServerName(name)) continue;
      next.set(name, { name, config: interpolateEnv(config, process.env), source: "config" });
    }

    // Upper layer: files override (and add to) config entries.
    let entries: string[] = [];
    try {
      entries = readdirSync(this.opts.dir).filter((f) => MCP_FILE_RE.test(f)).sort();
    } catch {
      // Directory vanished mid-run: keep serving the previous set.
    }
    for (const file of entries) {
      const full = path.join(this.opts.dir, file);
      const stem = file.replace(MCP_FILE_RE, "");
      try {
        const parsed = parseMcpFile(readFileSync(full, "utf8"), stem);
        if (parsed === undefined) {
          console.warn(`[bai] MCP file ignored (not a server or mcpServers wrapper): ${file}`);
          continue;
        }
        for (const entry of parsed) {
          if (!isValidMcpServerName(entry.name)) {
            console.warn(`[bai] MCP file ignored, invalid server name "${entry.name}": ${file}`);
            continue;
          }
          next.set(entry.name, {
            name: entry.name,
            config: interpolateEnv(entry.config, process.env),
            source: "file",
            path: full,
          });
        }
      } catch (err) {
        console.warn(`[bai] MCP file ignored (unreadable): ${file}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const signature = JSON.stringify(
      [...next.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, server]) => [name, server.source, server.config]),
    );
    const changed = signature !== this.signature;
    this.servers = next;
    this.signature = signature;
    return changed;
  }

  get(name: string): ResolvedMcpServer | undefined {
    return this.servers.get(name);
  }

  list(): ResolvedMcpServer[] {
    return [...this.servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Absolute path of the JSON file that defines (or would define) `name`. */
  fileFor(name: string): string {
    return path.join(this.opts.dir, `${name}.json`);
  }

  /** Create or replace `~/.config/bai/mcp/<name>.json`; surfaces are notified. */
  put(name: string, config: MCPServerConfig): ResolvedMcpServer {
    if (!isValidMcpServerName(name)) throw new Error(`Invalid MCP server name: ${name}`);
    const file = this.fileFor(name);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(tmp, file);
    if (this.scan() && this.opts.onChange) this.opts.onChange();
    return this.get(name) as ResolvedMcpServer;
  }

  /** Delete the file defining `name`. Returns false when no file exists. */
  remove(name: string): boolean {
    for (const ext of [".json", ".yaml", ".yml"]) {
      const file = path.join(this.opts.dir, `${name}${ext}`);
      if (!existsSync(file)) continue;
      rmSync(file);
      if (this.scan() && this.opts.onChange) this.opts.onChange();
      return true;
    }
    return false;
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
        `[bai] MCP hot-reload unavailable (${err instanceof Error ? err.message : err}); restart to pick up MCP file changes`,
      );
    }
  }
}

/** Parse one MCP file into `(name, config)` entries (undefined when invalid). */
export function parseMcpFile(
  source: string,
  stem: string,
): { name: string; config: MCPServerConfig }[] | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch {
    return undefined;
  }
  const parsed = mcpServerFileSchema.safeParse(doc);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  if ("mcpServers" in data && data.mcpServers !== undefined) {
    return Object.entries(data.mcpServers).map(([name, config]) => ({ name, config }));
  }
  return [{ name: stem, config: data as MCPServerConfig }];
}

/** Serialize a server back to YAML (used only by tooling/tests). */
export function serializeMcpServer(config: MCPServerConfig): string {
  return stringifyYaml(config);
}
