import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid, type EventType, type SessionId } from "@bai/shared";
import type { AuthorizeResult } from "../permissions/ask";

/** Context handed to tools at execution time. */
export interface ToolContext {
  sessionId: SessionId;
  cwd?: string;
  signal: AbortSignal;
  /** Name of the agent executing this call (run context) — analytics attribution. */
  agent?: string;
  /** Emit a live-only event (firehose). */
  emitLive(type: EventType, payload: unknown): void;
  /**
   * Raise an interactive permission ask for this tool call (write/edit use
   * it implicitly via the central gate; custom tools may call it directly).
   * Resolves with the gate verdict (a denial may carry user feedback).
   * `metadata` (e.g. a diff) rides the permission.asked event to surfaces.
   */
  ask?(tool: string, metadata?: Record<string, unknown>): Promise<AuthorizeResult>;
  /**
   * Switch the session's agent mid-run (plan.exit → build). Sets
   * session.meta.agent and broadcasts session.updated; the drain loop
   * re-resolves agent/model/tools before the next step. Resolves false when
   * the target agent is unknown or the session is gone.
   */
  switchAgent?(name: string): Promise<boolean>;
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

/**
 * Tool output above this size is truncated head+tail (last resort only) and
 * spilled to disk. Line-oriented readers such as fs.read stay under this
 * budget on their own (`fs/window.ts`) so they are never elided mid-file.
 */
export const OUTPUT_LIMIT = 32_000;
const HEAD_KEEP = 8_000;
const TAIL_KEEP = 8_000;

/**
 * Where to cut the head of an oversized output: the last newline at or before
 * `max`, so the kept fragment never ends mid-line. Falls back to `max` when a
 * single line spans the whole head.
 */
function headCut(text: string, max: number): number {
  const nl = text.lastIndexOf("\n", max);
  return nl > 0 ? nl : max;
}

/**
 * Where to resume the tail: the first newline at or after `min`, so the kept
 * fragment never starts mid-line (mangled line numbers, half statements).
 */
function tailCut(text: string, min: number): number {
  const nl = text.indexOf("\n", Math.max(0, min));
  return nl >= 0 ? nl + 1 : min;
}

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

  /**
   * Last-resort truncation for outputs that blew past the limit anyway:
   * keep a line-aligned head and tail, spill the full text to a managed file,
   * and say plainly that the gap is the *middle* of the output — never the
   * end — so the model keeps paging instead of assuming it read everything.
   */
  private bound(result: ToolResult): ToolResult {
    if (result.content.length <= OUTPUT_LIMIT) return result;
    const spillPath = this.spill(result.content);
    const head = headCut(result.content, HEAD_KEEP);
    const tail = tailCut(result.content, result.content.length - TAIL_KEEP);
    const elided = Math.max(0, tail - head);
    return {
      ...result,
      content:
        `${result.content.slice(0, head)}\n\n[… ${elided} characters elided — this is the MIDDLE of the ` +
        `output, not the end. Full output spilled to ${spillPath} — page it with fs.read ` +
        `(offset/limit) or search it with fs.grep …]\n\n${result.content.slice(tail)}`,
      meta: { ...result.meta, spilledTo: spillPath, elidedChars: elided, truncated: true },
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
