/**
 * Custom tool wire types — surfaces list and manage tool files via the API;
 * the files remain the source of truth.
 */

/** GET /api/tool response entry — a registered tool (built-in or file). */
export interface ToolListEntry {
  name: string;
  description: string;
  /** "builtin" | "file" | "mcp/<server>" (future). */
  origin: string;
  /** JSON Schema for the tool's arguments. */
  schema: unknown;
  /** Absolute file path for file-origin tools (undefined for built-ins). */
  path?: string;
  /**
   * True when the name belongs to a built-in tool. For `origin: "file"`
   * entries this marks an OVERRIDE — deleting its file restores the
   * built-in (surfaces render "reset to default" instead of "delete").
   */
  builtin?: boolean;
}

/** Valid custom-tool names (also the filename stem). */
export function isValidToolName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
}
