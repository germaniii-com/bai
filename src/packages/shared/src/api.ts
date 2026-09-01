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
});

/** POST /api/job */
export const enqueueJobSchema = z.object({
  kind: z.enum(["image.generate", "video.generate"]),
  sessionId: z.string().optional(),
  input: z.unknown(),
});

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type PromptPayloadBody = z.infer<typeof promptPayloadSchema>;
export type PermissionReplyBody = z.infer<typeof permissionReplySchema>;
export type EnqueueJobBody = z.infer<typeof enqueueJobSchema>;
export type RenameSessionBody = z.infer<typeof renameSessionSchema>;
