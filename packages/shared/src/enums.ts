import type { AssetId, InputId, JobId, MessageId, PartId, PermissionRequestId, QuestionRequestId, SessionId } from "./ids";
import type { Asset, Job, Message, PermissionRequest, QuestionRequest, Session, TodoItem } from "./domain";

/** Modality names — the workbench registry keys. */
export type WorkbenchName = "chat" | "code" | "image" | "video";

export type Role = "user" | "assistant" | "system";

export type PartKind = "text" | "thinking" | "file" | "image" | "tool_call" | "tool_result" | "patch";

export type InputState = "admitted" | "promoted" | "cancelled";

export type PermissionAction = "allow" | "ask" | "deny";

export type JobKind = "image.generate" | "video.generate";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export type AssetKind = "image" | "video" | "audio" | "file";

export type PermissionStatus = "pending" | "approved" | "rejected";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TodoPriority = "high" | "medium" | "low";

// Re-exported domain shapes live in domain.ts; these aliases keep imports tidy.
export type { Asset, Job, Message, PermissionRequest, Session, TodoItem };

/** Typed event names → payload shapes. The wire contract between server and every surface. */
export interface EventPayloads {
  "session.created": { session: Session };
  "session.updated": { session: Session };
  "input.admitted": { inputId: InputId; sessionId: SessionId; text: string; queued: boolean };
  "message.created": { messageId: MessageId; role: Role };
  "message.part.updated": { messageId: MessageId; partId: PartId; kind: PartKind; payload: unknown };
  "message.part.delta": { messageId: MessageId; partId: PartId; delta: string };
  /** A message was hard-deleted (revert cleanup at next prompt admission). */
  "message.removed": { messageId: MessageId };
  "run.started": Record<string, never>;
  "run.finished": { aborted?: boolean; error?: string };
  "permission.asked": { request: PermissionRequest };
  "permission.replied": { requestId: PermissionRequestId; status: PermissionRequest["status"] };
  /** The agent asks the user questions mid-run (the `question` tool). */
  "question.asked": { request: QuestionRequest };
  "question.replied": { requestId: QuestionRequestId; answers: string[][] };
  "question.rejected": { requestId: QuestionRequestId; message?: string };
  /** The session todo list changed (the `todo` tool; list lives in session.meta). */
  "todos.updated": { todos: TodoItem[] };
  "job.updated": { job: Job };
  "asset.created": { asset: Asset };
  "config.updated": Record<string, never>;
  /** Accounts changed (added/removed) — live-only, surfaces refetch providers. */
  "provider.updated": Record<string, never>;
  /** Agent set changed (file created/edited/deleted) — live-only, surfaces refetch. */
  "agents.updated": Record<string, never>;
  /** Custom tool set changed (file created/edited/deleted) — live-only, surfaces refetch. */
  "tools.updated": Record<string, never>;
  "server.hello": { version: string };
}

export type EventType = keyof EventPayloads;

export const EVENT_TYPES = Object.keys({
  "session.created": 1,
  "session.updated": 1,
  "input.admitted": 1,
  "message.created": 1,
  "message.part.updated": 1,
  "message.part.delta": 1,
  "message.removed": 1,
  "run.started": 1,
  "run.finished": 1,
  "permission.asked": 1,
  "permission.replied": 1,
  "question.asked": 1,
  "question.replied": 1,
  "question.rejected": 1,
  "todos.updated": 1,
  "job.updated": 1,
  "asset.created": 1,
  "config.updated": 1,
  "provider.updated": 1,
  "agents.updated": 1,
  "tools.updated": 1,
  "server.hello": 1,
} satisfies Record<EventType, 1>) as EventType[];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as string[]).includes(value);
}

/** Convenience alias used when emitting asset/job references inside payloads. */
export type AssetRef = { id: AssetId; kind: Asset["kind"] };
export type JobRef = { id: JobId; kind: Job["kind"] };
