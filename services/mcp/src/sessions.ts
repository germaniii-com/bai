import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { Message, SessionId, WorkbenchName } from "@bai/shared";
import { recordInbound, resultBytes } from "./analytics";
import type { McpServerDeps } from "./deps";

/**
 * The session half of the MCP server role: basic session operations so an
 * external agent can drive bai (`session_create`, `session_prompt`,
 * `session_history`, `session_list`) plus the SHARED session that direct tool
 * calls run under.
 *
 * The shared session is process-level (v2 stateless HTTP has no protocol
 * session id): created lazily, reused across requests, and stamped
 * `meta.autoApprove` so external calls run unattended. It is a real bai
 * session — visible in the UI, event-sourced, and revert-aware for work done
 * through `session_prompt`.
 */

const WORKBENCHES = ["chat", "code", "image", "video"] as const;

const CREATE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Session title (default: an auto title)." },
    workbench: { type: "string", enum: WORKBENCHES, description: "Session workbench (default: code)." },
    cwd: { type: "string", description: "Working directory for the session." },
    agent: { type: "string", description: "Agent name for the session." },
    model: { type: "string", description: "Explicit provider/model for the session." },
  },
} as const;

const PROMPT_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string", description: "Target session id." },
    text: { type: "string", description: "Prompt text to submit." },
    queue: { type: "boolean", description: "Queue behind the current run instead of steering." },
  },
  required: ["sessionId", "text"],
} as const;

const HISTORY_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string", description: "Target session id." },
    limit: { type: "number", description: "Maximum messages to return (default 50)." },
  },
  required: ["sessionId"],
} as const;

const LIST_SCHEMA = {
  type: "object",
  properties: {
    limit: { type: "number", description: "Maximum sessions to return (default 50)." },
    workbench: { type: "string", enum: WORKBENCHES, description: "Filter by workbench." },
  },
} as const;

/** The last non-empty assistant text in a session's history. */
export function finalAssistantText(history: readonly Message[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role !== "assistant") continue;
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j];
      if (part?.kind !== "text") continue;
      const text = (part.payload as { text?: string }).text ?? "";
      if (text.trim().length > 0) return text;
    }
  }
  return undefined;
}

/** One `role: text` line per message part, for `session_history`. */
function renderHistory(history: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of history) {
    for (const part of message.parts) {
      if (part.kind === "text") {
        lines.push(`[${message.role}] ${(part.payload as { text?: string }).text ?? ""}`);
      } else if (part.kind === "tool_call") {
        const payload = part.payload as { name?: string };
        lines.push(`[${message.role}] (tool call: ${payload.name ?? "unknown"})`);
      }
    }
  }
  return lines.join("\n");
}

/** Lazily-created, process-level session for direct tool calls and session ops. */
export class SharedSession {
  private id: SessionId | undefined;
  private pending: Promise<SessionId> | undefined;

  constructor(private readonly deps: McpServerDeps) {}

  /** Resolve the shared session, creating it on first use (concurrency-safe). */
  get(): Promise<SessionId> {
    if (this.id !== undefined) {
      if (this.deps.store.sessions.get(this.id) !== undefined) return Promise.resolve(this.id);
      // The session was deleted — fall through and recreate.
      this.id = undefined;
    }
    if (this.pending !== undefined) return this.pending;
    this.pending = this.create()
      .then((sessionId) => {
        this.id = sessionId;
        return sessionId;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private create(): Promise<SessionId> {
    const config = this.deps.config();
    const shape = config.mcpServer?.session;
    const session = this.deps.core.createSession({
      workbench: "code",
      title: "MCP (external)",
      ...(shape?.cwd !== undefined ? { cwd: shape.cwd } : {}),
      ...(shape?.agent !== undefined ? { agent: shape.agent } : {}),
      ...(shape?.model !== undefined ? { model: shape.model } : {}),
      meta: {
        mcpServer: true,
        ...(shape?.account !== undefined ? { account: shape.account } : {}),
        ...(config.mcpServer?.autoApprove !== false ? { autoApprove: true } : {}),
      },
    });
    return Promise.resolve(session.id);
  }
}

/** `meta.autoApprove` for sessions this server creates (default ON). */
function autoApproveMeta(deps: McpServerDeps): Record<string, unknown> {
  return deps.config().mcpServer?.autoApprove !== false ? { autoApprove: true } : {};
}

export function registerSessionTools(server: McpServer, deps: McpServerDeps, shared: SharedSession): void {
  server.registerTool(
    "session_create",
    {
      title: "Create session",
      description: "Create a bai session (chat/code/image/video) and return its id.",
      inputSchema: fromJsonSchema(CREATE_SCHEMA),
    },
    async (args) => {
      const started = Date.now();
      try {
        const input = (args ?? {}) as {
          title?: string;
          workbench?: WorkbenchName;
          cwd?: string;
          agent?: string;
          model?: string;
        };
        const session = deps.core.createSession({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.workbench !== undefined ? { workbench: input.workbench } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          meta: autoApproveMeta(deps),
        });
        recordInbound(deps, { tool: "session_create", kind: "tool", ok: true, durationMs: Date.now() - started, sessionId: session.id });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionId: session.id, title: session.title, workbench: session.workbench }),
            },
          ],
        };
      } catch (err) {
        return fail(deps, "session_create", started, err);
      }
    },
  );

  server.registerTool(
    "session_prompt",
    {
      title: "Prompt session",
      description:
        "Submit a prompt to a bai session and wait for the run to go idle; returns the assistant's final text. This is the auditable path (transcript + revert) — prefer it for real work.",
      inputSchema: fromJsonSchema(PROMPT_SCHEMA),
    },
    async (args) => {
      const started = Date.now();
      const input = (args ?? {}) as { sessionId?: string; text?: string; queue?: boolean };
      const sessionId = input.sessionId as SessionId | undefined;
      try {
        if (sessionId === undefined || (input.text ?? "").trim().length === 0) {
          throw new Error("sessionId and text are required");
        }
        deps.core.submitPrompt(sessionId, {
          text: input.text as string,
          ...(input.queue === true ? { queue: true } : {}),
        });
        await deps.core.drainNow(sessionId);
        const text = finalAssistantText(deps.core.history(sessionId)) ?? "(no assistant response)";
        recordInbound(deps, {
          tool: "session_prompt",
          kind: "tool",
          ok: true,
          durationMs: Date.now() - started,
          bytes: resultBytes(text),
          sessionId,
        });
        return { content: [{ type: "text", text }] };
      } catch (err) {
        recordInbound(deps, {
          tool: "session_prompt",
          kind: "tool",
          ok: false,
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "session_history",
    {
      title: "Session history",
      description: "Read a bai session's message history as text.",
      inputSchema: fromJsonSchema(HISTORY_SCHEMA),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const started = Date.now();
      const input = (args ?? {}) as { sessionId?: string; limit?: number };
      const sessionId = input.sessionId as SessionId | undefined;
      try {
        if (sessionId === undefined) throw new Error("sessionId is required");
        if (deps.core.getSession(sessionId) === undefined) throw new Error(`Unknown session: ${sessionId}`);
        const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 500) : 50;
        const text = renderHistory(deps.core.history(sessionId, { limit }));
        recordInbound(deps, {
          tool: "session_history",
          kind: "tool",
          ok: true,
          durationMs: Date.now() - started,
          bytes: resultBytes(text),
          sessionId,
        });
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return fail(deps, "session_history", started, err, sessionId);
      }
    },
  );

  server.registerTool(
    "session_list",
    {
      title: "List sessions",
      description: "List bai sessions (id, title, workbench, updated).",
      inputSchema: fromJsonSchema(LIST_SCHEMA),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const started = Date.now();
      try {
        const input = (args ?? {}) as { limit?: number; workbench?: WorkbenchName };
        const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 200) : 50;
        const sessions = deps.core.listSessions(limit, 0, {
          ...(input.workbench !== undefined ? { workbench: input.workbench } : {}),
        });
        const text =
          sessions.length === 0
            ? "No sessions."
            : sessions
                .map((session) => `${session.id} | ${session.title} | ${session.workbench} | ${session.updatedAt}`)
                .join("\n");
        recordInbound(deps, { tool: "session_list", kind: "tool", ok: true, durationMs: Date.now() - started, bytes: resultBytes(text) });
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return fail(deps, "session_list", started, err);
      }
    },
  );

  // Keep the shared session warm so the first tool call doesn't pay session
  // creation inside a client's timeout (best-effort; never blocks startup).
  void shared.get().catch(() => undefined);
}

function fail(
  deps: McpServerDeps,
  tool: string,
  started: number,
  err: unknown,
  sessionId?: SessionId,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  recordInbound(deps, {
    tool,
    kind: "tool",
    ok: false,
    durationMs: Date.now() - started,
    error: message,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  return { content: [{ type: "text", text: message }], isError: true };
}
