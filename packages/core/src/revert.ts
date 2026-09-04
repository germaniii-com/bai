import type { MessageId, RevertState } from "@bai/shared";
import type { SnapshotPatch } from "./snapshot";

/**
 * Tools whose execution can change the worktree — a batch containing any of
 * them gets a shadow-repo snapshot + a `patch` part recording the pre-change
 * tree and the files touched (the revert rollback input).
 */
export const SNAPSHOT_TOOLS = new Set(["bash", "fs.edit", "fs.write", "task"]);

/** Read `session.meta.revert` (two-phase revert boundary), validated. */
export function readRevert(meta: Record<string, unknown>): RevertState | undefined {
  const raw = meta.revert;
  if (raw === null || typeof raw !== "object") return undefined;
  const candidate = raw as { messageId?: unknown; snapshot?: unknown; diff?: unknown };
  if (typeof candidate.messageId !== "string" || candidate.messageId.length === 0) return undefined;
  const revert: RevertState = { messageId: candidate.messageId as MessageId };
  if (typeof candidate.snapshot === "string" && candidate.snapshot.length > 0) revert.snapshot = candidate.snapshot;
  if (typeof candidate.diff === "string") revert.diff = candidate.diff;
  return revert;
}

/** Validate a `patch` part payload ({hash, files}). */
export function isPatchPayload(value: unknown): value is SnapshotPatch {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { hash?: unknown; files?: unknown };
  if (typeof candidate.hash !== "string" || candidate.hash.length === 0) return false;
  return Array.isArray(candidate.files) && candidate.files.every((f) => typeof f === "string");
}

/** Fork titles count up: "X" → "X (fork #1)" → "X (fork #2)" (opencode parity). */
export function forkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/);
  if (match !== null) return `${match[1]} (fork #${Number(match[2]) + 1})`;
  return `${title} (fork #1)`;
}
