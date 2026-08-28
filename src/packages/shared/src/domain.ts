import type {
  AssetKind,
  InputState,
  JobKind,
  JobStatus,
  PartKind,
  PermissionAction,
  PermissionStatus,
  Role,
  WorkbenchName,
} from "./enums";
import type {
  AssetId,
  InputId,
  JobId,
  MessageId,
  PartId,
  PermissionRequestId,
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
  /** Shape depends on `kind`: text → {text}, tool_call → {name,args}, etc. */
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

export interface PermissionRequest {
  id: PermissionRequestId;
  sessionId?: SessionId;
  tool: string;
  argsDigest: string;
  status: PermissionStatus;
  rule?: string;
  createdAt: string;
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
}
