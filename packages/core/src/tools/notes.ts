import type { SessionId } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * notes.read / notes.write — the session's free-form note (`notes.md` in the
 * session directory). The note is the user's scratchpad, but the agent can
 * read it for context and append/replace it when asked (the user chose
 * read+write agent access). Both routes go through the injected Service
 * methods, so a write emits the durable `notes.updated` event and every
 * surface's Notes panel updates live. No path argument exists — the file is
 * always the calling session's own note, so there is no escape surface.
 */
export function notesTools(deps: {
  readNotes: (sessionId: SessionId) => string | null;
  writeNotes: (sessionId: SessionId, content: string) => void;
}): Tool[] {
  const read: Tool = {
    name: "notes.read",
    origin: "builtin",
    description:
      "Read the current session's note (the user's scratchpad, shown in the session's Notes panel). " +
      "Use it when you need context the user jotted down.",
    schema: { type: "object", properties: {}, required: [] },
    async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const notes = deps.readNotes(ctx.sessionId as SessionId);
      if (notes === null || notes.trim().length === 0) {
        return { content: "The session note is empty.", meta: { notes: "", title: "Read session notes" } };
      }
      return { content: notes, meta: { notes, title: "Read session notes" } };
    },
  };

  const write: Tool = {
    name: "notes.write",
    origin: "builtin",
    description:
      "Replace the current session's note (markdown) with new content. The note is the user's scratchpad — " +
      "read it first with notes.read, keep their content unless asked to change it, and don't use it as a " +
      "workspace file. Send the full note text (it replaces the previous note).",
    schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown content of the note (replaces the previous note)" },
      },
      required: ["content"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { content } = args as { content?: string };
      if (typeof content !== "string") throw new Error("content must be a string.");
      deps.writeNotes(ctx.sessionId as SessionId, content);
      return {
        content: `Session note updated (${Buffer.byteLength(content)} bytes).`,
        meta: { notes: content, title: "Updated session notes" },
      };
    },
  };

  return [read, write];
}
