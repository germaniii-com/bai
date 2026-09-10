import type { Message, Part } from "@bai/shared";
import type { ContentBlock, OutboundMessage } from "../provider/types";

/**
 * Stored history (messages + typed parts) → provider-neutral outbound
 * messages. This is the boundary between the durable transcript and the
 * vendor wire format:
 *
 * - system prompt (agent persona) becomes one leading system message;
 * - an assistant turn's text/thinking/tool_call parts become its blocks;
 * - its tool_result parts move into a synthetic FOLLOWING user message —
 *   the shape every provider expects (Anthropic: user tool_result blocks;
 *   OpenAI-compat: role:"tool" messages);
 * - tool_use calls left without a result (interrupted run) are closed with
 *   a synthetic error result — Anthropic strictly pairs tool_use/tool_result
 *   and rejects dangling calls (opencode message-v2 lesson).
 *
 * Pure function: token-discipline pre-passes (Phase 6) transform the
 * Message[] before this render.
 */

/** Payload shape of a persisted tool_call part. */
export interface ToolCallPayload {
  callId: string;
  name: string;
  /** Raw JSON text as streamed by the model. */
  args: string;
}

/** Payload shape of a persisted tool_result part. */
export interface ToolResultPayload {
  callId: string;
  content: string;
  isError?: boolean;
  title?: string;
}

/**
 * Payload shape of a persisted `file` part — the attached read context for a
 * `#file[:from-to]` mention or a text attachment (written by
 * `appendPromotedInputs`). `content` is the numbered line slice, a directory
 * listing, or an error message.
 */
export interface FilePartPayload {
  path: string;
  from?: number;
  to?: number;
  content: string;
  error?: boolean;
  /** Set for text attachments: the stored asset backing this read context. */
  assetId?: string;
  mime?: string;
}

/** Payload shape of a persisted `attachment` part (image or PDF). */
export interface AttachmentPartPayload {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  kind: "image" | "pdf";
}

export function isAttachmentPayload(payload: unknown): payload is AttachmentPartPayload {
  const p = payload as AttachmentPartPayload | null;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof p?.id === "string" &&
    typeof p.name === "string" &&
    typeof p.mime === "string" &&
    (p.kind === "image" || p.kind === "pdf")
  );
}

/** Resolved attachment bytes (base64) for one provider message. */
export interface ResolvedAttachment {
  mediaType: string;
  /** base64, no `data:` prefix. */
  data: string;
  /** PDF display filename (OpenAI `file` parts). */
  filename?: string;
}

export function isToolCallPayload(payload: unknown): payload is ToolCallPayload {
  return typeof payload === "object" && payload !== null && typeof (payload as ToolCallPayload).callId === "string" && typeof (payload as ToolCallPayload).name === "string";
}

export function isToolResultPayload(payload: unknown): payload is ToolResultPayload {
  return typeof payload === "object" && payload !== null && typeof (payload as ToolResultPayload).callId === "string" && typeof (payload as ToolResultPayload).content === "string";
}

export function renderOutbound(
  messages: Message[],
  opts: { system?: string[]; resolveAttachment?: (part: Part) => ResolvedAttachment | undefined } = {},
): OutboundMessage[] {
  const out: OutboundMessage[] = [];

  const system = (opts.system ?? []).filter((s) => s.trim().length > 0);
  if (system.length > 0) out.push({ role: "system", content: system.join("\n\n") });

  for (const message of messages) {
    if (message.parts.length === 0) continue;

    if (message.role === "user") {
      const text = message.parts
        .filter((p) => p.kind === "text")
        .map((p) => textOf(p))
        .filter((t) => t.length > 0)
        .join("\n");
      const extra: string[] = [];
      const media: ContentBlock[] = [];
      for (const part of message.parts) {
        if (part.kind === "file") {
          const block = renderFileBlock(part);
          if (block.length > 0) extra.push(block);
        } else if (part.kind === "attachment") {
          if (isAttachmentPayload(part.payload)) {
            const resolved = opts.resolveAttachment?.(part);
            if (resolved !== undefined) {
              media.push(
                part.payload.kind === "image"
                  ? { type: "image", mediaType: resolved.mediaType, data: resolved.data }
                  : { type: "file", mediaType: resolved.mediaType, data: resolved.data, ...(resolved.filename !== undefined ? { filename: resolved.filename } : {}) },
              );
            } else {
              extra.push(`[attachment omitted: ${part.payload.name}]`);
            }
          } else {
            // Discipline-stubbed attachment (older than the retention window).
            const p = part.payload as { omitted?: unknown; name?: unknown } | null;
            if (p?.omitted === true) extra.push(`[attachment omitted: ${typeof p.name === "string" ? p.name : "file"}]`);
          }
        }
      }
      if (media.length === 0) {
        const content = [text, ...extra].filter((s) => s.length > 0).join("\n\n");
        if (content.length > 0) out.push({ role: "user", content });
        continue;
      }
      const content: ContentBlock[] = [];
      const joined = [text, ...extra].filter((s) => s.length > 0).join("\n\n");
      if (joined.length > 0) content.push({ type: "text", text: joined });
      content.push(...media);
      out.push({ role: "user", content });
      continue;
    }
    if (message.role !== "assistant") continue;

    const blocks: ContentBlock[] = [];
    const results: ContentBlock[] = [];
    const requested = new Set<string>();
    const answered = new Set<string>();

    for (const part of message.parts) {
      if (part.kind === "text") {
        const text = textOf(part);
        if (text.length > 0) blocks.push({ type: "text", text });
      } else if (part.kind === "thinking") {
        const text = textOf(part);
        if (text.length > 0) blocks.push({ type: "thinking", text });
      } else if (part.kind === "tool_call" && isToolCallPayload(part.payload)) {
        blocks.push({ type: "tool_use", callId: part.payload.callId, name: part.payload.name, args: part.payload.args });
        requested.add(part.payload.callId);
      } else if (part.kind === "tool_result" && isToolResultPayload(part.payload)) {
        results.push({
          type: "tool_result",
          callId: part.payload.callId,
          content: part.payload.content,
          ...(part.payload.isError === true ? { isError: true } : {}),
        });
        answered.add(part.payload.callId);
      }
    }

    if (blocks.length === 0 && results.length === 0) continue;
    // Text-only turns stay plain strings — the compact, cache-friendly shape
    // that predates tool parts; structured blocks only when tools are present.
    const hasStructure = blocks.some((b) => b.type !== "text");
    out.push({ role: "assistant", content: hasStructure ? blocks : blocks.map((b) => (b.type === "text" ? b.text : "")).join("") });

    // Close dangling calls so strict providers accept the replay.
    for (const callId of requested) {
      if (!answered.has(callId)) {
        results.push({ type: "tool_result", callId, content: "[Tool execution was interrupted]", isError: true });
      }
    }
    if (results.length > 0) out.push({ role: "user", content: results });
  }

  return out;
}

function textOf(part: Part): string {
  const payload = part.payload as { text?: unknown } | null;
  return typeof payload?.text === "string" ? payload.text : "";
}

/**
 * Render a `file` mention part as a `<file>` block attached to the user turn.
 * The transcript keeps the visible `#path` token; this is what the model sees.
 */
function renderFileBlock(part: Part): string {
  const p = part.payload as FilePartPayload | null;
  if (p === null || typeof p !== "object" || typeof p.content !== "string") return "";
  const attrs = [`path="${p.path.replace(/"/g, "'")}"`];
  if (p.from !== undefined) attrs.push(p.to !== undefined ? `lines="${p.from}-${p.to}"` : `lines="${p.from}-"`);
  if (p.error === true) attrs.push(`error="true"`);
  return `<file ${attrs.join(" ")}>\n${p.content}\n</file>`;
}
