import type { AssetKind, JobId, JobKind, WorkbenchName } from "@bai/shared";
import type { Tool } from "../tools/registry";

/** Extra HTTP routes a workbench mounts under /wb/<name>/ (Web-standard handlers). */
export interface WbRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handle(req: Request): Promise<Response> | Response;
}

export interface JobExecutorContext {
  progress(pct: number): void;
  signal: AbortSignal;
  sessionId?: SessionIdForJobs;
}

/** Avoid importing shared SessionId here to keep the contract dependency-light. */
type SessionIdForJobs = string;

export interface GeneratedFile {
  kind: AssetKind;
  mime: string;
  ext: string;
  bytes: Uint8Array;
  meta?: Record<string, unknown>;
}

export interface JobExecutorResult {
  output?: unknown;
  files: GeneratedFile[];
}

export type JobExecutor = (
  job: { id: JobId; input: unknown },
  ctx: JobExecutorContext,
) => Promise<JobExecutorResult>;

/**
 * The modality seam: a workbench teaches bai a kind of work — which tools
 * exist, what async jobs it can run, what asset kinds it produces, and which
 * extra HTTP routes it mounts. Stubs must stay end-to-end honest.
 */
export interface Workbench {
  name(): WorkbenchName;
  label(): string;
  tools(): Tool[];
  jobTypes(): JobKind[];
  assetKinds(): AssetKind[];
  jobExecutors(): Partial<Record<JobKind, JobExecutor>>;
  routes(): WbRoute[];
}
