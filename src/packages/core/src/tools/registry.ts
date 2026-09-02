import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid, type EventType, type SessionId } from "@bai/shared";

/** Context handed to tools at execution time. */
export interface ToolContext {
  sessionId: SessionId;
  cwd?: string;
  signal: AbortSignal;
  /** Emit a live-only event (firehose). */
  emitLive(type: EventType, payload: unknown): void;
  /**
   * Raise an interactive permission ask for this tool call (write/edit use
   * it implicitly via the central gate; custom tools may call it directly).
   * Resolves true when approved. `metadata` (e.g. a diff) rides the
   * permission.asked event to surfaces.
   */
  ask?(tool: string, metadata?: Record<string, unknown>): Promise<boolean>;
}

export interface ToolResult {
  content: string;
  meta?: Record<string, unknown>;
}

export interface Tool {
  /** Namespaced name, e.g. "fs.read", "mcp/myserver/search". */
  name: string;
  description: string;
  /** JSON Schema for arguments. */
  schema: Record<string, unknown>;
  /** Where the tool comes from — built-in, a user tool file, or "mcp/<server>". */
  origin?: "builtin" | "file" | string;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Tool output above this size is truncated head+tail and spilled to disk. */
export const OUTPUT_LIMIT = 32_000;
const HEAD_KEEP = 8_000;
const TAIL_KEEP = 8_000;

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(private opts: { spillDir?: string } = {}) {}

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  /**
   * Register or replace a tool under the same name (hot-reload of custom
   * tools). Returns true when an existing registration was replaced.
   */
  replace(tool: Tool): boolean {
    const existed = this.tools.has(tool.name);
    this.tools.set(tool.name, tool);
    return existed;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** True when a tool with this name is currently registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const result = await tool.execute(args, ctx);
    return this.bound(result);
  }

  /** Truncate head+tail past the limit; spill the full text to a managed file. */
  private bound(result: ToolResult): ToolResult {
    if (result.content.length <= OUTPUT_LIMIT) return result;
    const spillPath = this.spill(result.content);
    const elided = result.content.length - HEAD_KEEP - TAIL_KEEP;
    return {
      ...result,
      content:
        `${result.content.slice(0, HEAD_KEEP)}\n\n[… ${elided} characters elided — ` +
        `full output spilled to ${spillPath} …]\n\n${result.content.slice(-TAIL_KEEP)}`,
      meta: { ...result.meta, spilledTo: spillPath },
    };
  }

  private spill(text: string): string {
    const dir = this.opts.spillDir ?? "/tmp";
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tool-output-${ulid()}.txt`);
    writeFileSync(file, text);
    return file;
  }
}
