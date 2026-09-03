import type {
  AssetKind,
  InputState,
  JobKind,
  JobStatus,
  PartKind,
  PermissionAction,
  PermissionStatus,
  Role,
  TodoPriority,
  TodoStatus,
  WorkbenchName,
} from "./enums";
import type {
  AssetId,
  InputId,
  JobId,
  MessageId,
  PartId,
  PermissionRequestId,
  QuestionRequestId,
  SessionId,
} from "./ids";

export interface Session {
  id: SessionId;
  title: string;
  workbench: WorkbenchName;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  meta: Record<string, unknown>;
}

export interface Part {
  id: PartId;
  messageId: MessageId;
  ord: number;
  kind: PartKind;
  /**
   * Shape depends on `kind`: text/thinking → {text}; tool_call →
   * {callId, name, args}; tool_result → {callId, content, isError?, title?,
   * subagent?} where `subagent` links a `task` result to its child session.
   */
  payload: unknown;
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  role: Role;
  createdAt: string;
  parts: Part[];
}

export interface PromptPayload {
  text: string;
  /** true → wait until idle instead of steering mid-run. */
  queue?: boolean;
}

export interface Input {
  id: InputId;
  sessionId: SessionId;
  payload: PromptPayload;
  state: InputState;
  createdAt: string;
}

/**
 * Renderable context attached to a permission ask so surfaces can show more
 * than a tool name — for fs.write/fs.edit this is a unified diff of the
 * proposed change (opencode embeds diffs in its asks the same way).
 */
export interface AskDetail {
  /** Human-facing one-liner, e.g. "create src/new.ts (1.2 KB)". */
  summary?: string;
  /** Unified diff (jsdiff format) for file mutations. */
  diff?: string;
  /** Primary file path the ask touches. */
  path?: string;
}

export interface PermissionRequest {
  id: PermissionRequestId;
  sessionId?: SessionId;
  tool: string;
  argsDigest: string;
  status: PermissionStatus;
  rule?: string;
  /** Ask-detail (summary/diff) computed by the tool-facing enricher, when any. */
  detail?: AskDetail;
  createdAt: string;
}

// --- questions (the agent asking the USER mid-run; opencode's question tool) ---

/** One selectable answer, shown with its explanation. */
export interface QuestionOption {
  /** Display text (1-5 words, concise). */
  label: string;
  /** Explanation of the choice. */
  description: string;
}

/** A single question posed to the user mid-run. */
export interface QuestionPrompt {
  question: string;
  /** Very short label (max ~30 chars). */
  header: string;
  options: QuestionOption[];
  /** Allow selecting multiple options (default: single-select). */
  multiple?: boolean;
}

/** A pending question block awaiting user answers. */
export interface QuestionRequest {
  id: QuestionRequestId;
  sessionId?: SessionId;
  questions: QuestionPrompt[];
}

// --- todos (the agent's tracked task list for the session) ---

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export interface Job {
  id: JobId;
  kind: JobKind;
  sessionId?: SessionId;
  status: JobStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  progress?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: AssetId;
  kind: AssetKind;
  mime: string;
  path: string;
  bytes: number;
  meta: Record<string, unknown>;
  jobId?: JobId;
  createdAt: string;
}

export interface ModelInfo {
  /** Catalog id, e.g. "anthropic/claude-sonnet-4-5". */
  id: string;
  provider: string;
  label: string;
  contextWindow?: number;
  supportsTools?: boolean;
  /** USD per 1M tokens (models.dev), when published. */
  inputCost?: number;
  outputCost?: number;
  /** Model emits reasoning tokens (models.dev); bai enables thinking for it. */
  reasoning?: boolean;
}
