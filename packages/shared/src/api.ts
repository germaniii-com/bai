import { z } from "zod";

/** POST /api/session */
export const createSessionSchema = z.object({
  title: z.string().max(200).optional(),
  workbench: z.enum(["chat", "code", "image", "video"]).default("chat"),
  cwd: z.string().optional(),
  /**
   * Ephemeral proxy run (bai --one-shot): the session lives in an in-memory
   * store and dies with the process — surfaces never list it, and core skips
   * title generation for it.
   */
  oneshot: z.boolean().optional(),
});

/** PUT /api/session/:id/title */
export const renameSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

/**
 * POST /api/session/:id/revert — revert to a USER message: it and everything
 * after it are hidden (hard-deleted at the next prompt admission) and file
 * changes made after it are rolled back via the shadow-repo snapshot.
 */
export const revertSessionSchema = z.object({
  messageId: z.string().min(1),
});

/** POST /api/session/:id/fork — copy history before messageId (all if omitted) into a new session. */
export const forkSessionSchema = z.object({
  messageId: z.string().min(1).optional(),
});

/** POST /api/session/:id/message */
export const promptPayloadSchema = z.object({
  text: z.string().min(1).max(1_000_000),
  queue: z.boolean().optional(),
});

/** POST /api/permission/:id/reply */
export const permissionReplySchema = z.object({
  status: z.enum(["approved", "rejected"]),
  /** "once" (default) or "always" (persists for the session). */
  scope: z.enum(["once", "always"]).default("once"),
  /**
   * Optional user feedback carried on rejection (opencode's CorrectedError):
   * the denied tool result tells the model WHY it was refused.
   */
  message: z.string().max(2000).optional(),
});

/** POST /api/question/:id/reply — one answer array per question, in order. */
export const questionReplySchema = z.object({
  answers: z.array(z.array(z.string().min(1)).max(20)).min(1).max(20),
});

/** POST /api/question/:id/reject — dismiss the whole question block. */
export const questionRejectSchema = z.object({
  message: z.string().max(2000).optional(),
});

/** POST /api/job */
export const enqueueJobSchema = z.object({
  kind: z.enum(["image.generate", "video.generate"]),
  sessionId: z.string().optional(),
  input: z.unknown(),
});

/** PUT /api/agent/:name — create or replace an agent markdown file. */
export const putAgentSchema = z.object({
  description: z.string().max(2000).optional(),
  model: z.string().max(200).optional(),
  tools: z.array(z.string().min(1).max(100)).max(50).optional(),
  prompt: z.string().min(1).max(100_000),
});

export type PutAgentBody = z.infer<typeof putAgentSchema>;

/** PUT /api/tool/:name — create or replace a custom tool file. */
export const putToolSchema = z.object({
  code: z.string().min(1).max(500_000),
});

/** GET /api/usage/analytics — dimension filters + time bucketing (see usage.ts). */
export const usageAnalyticsQuerySchema = z.object({
  from: z.string().max(40).optional(), // inclusive RFC3339 lower bound
  to: z.string().max(40).optional(), // EXCLUSIVE upper bound
  granularity: z.enum(["day", "month", "year"]).optional(),
  agent: z.string().max(200).optional(),
  workspace: z.string().max(1024).optional(),
  provider: z.string().max(200).optional(),
  account: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  kind: z.enum(["run", "title", "compaction"]).optional(),
});

export type PutToolBody = z.infer<typeof putToolSchema>;

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type PromptPayloadBody = z.infer<typeof promptPayloadSchema>;
export type PermissionReplyBody = z.infer<typeof permissionReplySchema>;
export type EnqueueJobBody = z.infer<typeof enqueueJobSchema>;
export type RenameSessionBody = z.infer<typeof renameSessionSchema>;
export type RevertSessionBody = z.infer<typeof revertSessionSchema>;
export type ForkSessionBody = z.infer<typeof forkSessionSchema>;
