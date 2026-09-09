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
   * subagent?, permission?, questions?, workspace?} where `subagent` links a
   * `task` result to its child session, `permission` retains an answered
   * interactive ask, `questions` retains answered Q&A (surfaces render both
   * as re-openable reviews in the transcript) and `workspace` links a
   * `workspace.create` result to the registered folder (surfaces render an
   * open action on the tool node); patch →
   * {hash, files} — the shadow-repo tree hash BEFORE the batch of tool
   * calls ran plus the files that batch changed (revert rolls each file
   * back to its state in that hash; opencode's patch parts, same shape).
   */
  payload: unknown;
}

/**
 * Revert state stamped on `session.meta.revert` (opencode's Session.Info.revert):
 * the boundary USER message — it and everything after it are hidden (and
 * hard-deleted at the next prompt admission) — plus the shadow-repo tree hash of
 * the pre-revert worktree (so unrevert can restore it) and the unified diff the
 * revert produced (surfaces render it in the reverted banner).
 */
export interface RevertState {
  messageId: MessageId;
  /** Shadow-repo tree hash of the worktree before the revert (unrevert target). */
  snapshot?: string;
  /** Unified diff (snapshot → rolled-back worktree) the revert produced. */
  diff?: string;
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
  /**
   * Delivery mode (opencode parity): true → the input waits in the queue
   * until the session would otherwise go idle (promoted one at a time);
   * false → steer semantics (promotes at the next safe boundary).
   */
  queued: boolean;
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

/**
 * An answered interactive permission ask, stamped onto the gated call's
 * tool_result part (payload key `permission`) so the transcript RETAINS
 * what was approved/refused: surfaces render it as a re-openable review
 * (the ask's summary/diff + the verdict) that survives reloads like any
 * history-backed part — parity with how task results keep their subagent
 * output viewable.
 */
export interface AskOutcome {
  status: "approved" | "rejected";
  scope: "once" | "always";
  /** The user's reject feedback, when given (opencode's CorrectedError). */
  message?: string;
  /** The ask's rendered detail (summary/diff) as the surfaces previewed it. */
  detail?: AskDetail;
}

/**
 * One retained Q&A row for a `question` tool result (payload key
 * `questions`) — surfaces render it as a re-openable review of what was
 * asked and what the user answered, instead of the model-facing sentence.
 */
export interface QuestionReview {
  /** Very short label, when the model provided one. */
  header?: string;
  question: string;
  /** The user's answer labels; empty = unanswered (dimmed as such). */
  answers: string[];
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

/**
 * A path ask — one pre-filled, freely editable text field with a confirm
 * (the workspace.create flow: the agent suggests a folder, the user edits
 * or confirms). A request carries exactly one of `questions` / `path`.
 */
export interface QuestionPathAsk {
  /** The prompt line, e.g. "Where should the workspace be created?". */
  prompt: string;
  /** Pre-filled editable answer (the suggested absolute path). */
  prefill: string;
  /** Optional one-liner under the prompt (context for the edit). */
  hint?: string;
}

/** A pending question block awaiting user answers. */
export interface QuestionRequest {
  id: QuestionRequestId;
  sessionId?: SessionId;
  /** Choice questions (the radio/checkbox block). */
  questions?: QuestionPrompt[];
  /** Path ask: one pre-filled editable text field + confirm. */
  path?: QuestionPathAsk;
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
