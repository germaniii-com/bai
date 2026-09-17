import { createHash } from "node:crypto";
import { MCP_SERVER_ROLE_LABEL, type McpInteractionKind, type SessionId } from "@bai/shared";
import type { McpServerDeps } from "./deps";

/**
 * Server-role usage analytics: every inbound MCP interaction (a bai tool call,
 * a skill prompt/resource read, or a session operation) records one
 * append-only `mcp_events` row with `server: "(bai)"`. Best-effort by contract:
 * analytics must never break a tool call (the client-side manager precedent).
 */
export interface InboundInteraction {
  tool: string;
  kind: McpInteractionKind;
  ok: boolean;
  durationMs: number;
  bytes?: number;
  error?: string;
  sessionId?: SessionId;
  agent?: string;
  args?: unknown;
}

export function recordInbound(deps: McpServerDeps, interaction: InboundInteraction): void {
  try {
    deps.store.mcpUsage.insert({
      ...(interaction.sessionId !== undefined ? { sessionId: interaction.sessionId } : {}),
      server: MCP_SERVER_ROLE_LABEL,
      tool: interaction.tool,
      kind: interaction.kind,
      ...(interaction.agent !== undefined ? { agent: interaction.agent } : {}),
      ok: interaction.ok,
      ...(interaction.error !== undefined ? { error: interaction.error } : {}),
      durationMs: Math.max(0, interaction.durationMs),
      bytes: interaction.bytes ?? 0,
      argsDigest: digestArgs(interaction.args),
      now: new Date().toISOString(),
    });
  } catch {
    // Analytics is advisory — never break an interaction.
  }
}

/** SHA-256 of the JSON args (first 16 hex chars); raw args are never stored. */
function digestArgs(args: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(args ?? {}) ?? "";
  } catch {
    json = "";
  }
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** `Buffer.byteLength` of a text result (0 when absent). */
export function resultBytes(text: string | undefined): number {
  return text === undefined ? 0 : Buffer.byteLength(text);
}
