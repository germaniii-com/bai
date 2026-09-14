import type { CallToolResult, GetPromptResult, ReadResourceResult } from "@modelcontextprotocol/client";

/** Namespaced tool name exposed to the model (`mcp/<server>/<tool>`). */
export function qualifiedToolName(server: string, tool: string): string {
  return `mcp/${server}/${tool}`;
}

/**
 * Normalize an MCP tool's `inputSchema` into the JSON Schema bai's registry
 * expects (object shape, explicit properties/required, closed by default).
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  const s = (schema ?? {}) as Record<string, unknown>;
  const properties = (s.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(s.required) ? s.required : [];
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function blockText(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  const b = block as Record<string, unknown>;
  if (b.type === "text" && typeof b.text === "string") return b.text;
  if (b.type === "resource" && typeof b.resource === "object" && b.resource !== null) {
    const resource = b.resource as Record<string, unknown>;
    if (typeof resource.text === "string") return resource.text;
    return `[resource ${typeof resource.uri === "string" ? resource.uri : ""}]`;
  }
  if (b.type === "image" || b.type === "audio") return `[${b.type} content]`;
  return "";
}

/** Flatten a `tools/call` result into text for the model. */
export function callResultToText(result: CallToolResult): string {
  const parts = (result.content ?? []).map(blockText).filter((t) => t.length > 0);
  if (parts.length > 0) return parts.join("\n\n");
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  return "";
}

/** Flatten a `resources/read` result into text. */
export function readResourceToText(result: ReadResourceResult): string {
  const parts = (result.contents ?? []).map(blockText).filter((t) => t.length > 0);
  return parts.join("\n\n");
}

/** Flatten a `prompts/get` result into text. */
export function promptResultToText(result: GetPromptResult): string {
  const lines: string[] = [];
  if (result.description !== undefined && result.description.length > 0) lines.push(result.description);
  for (const message of result.messages ?? []) {
    const text = blockText(message.content);
    if (text.length > 0) lines.push(`[${message.role}] ${text}`);
  }
  return lines.join("\n\n");
}
