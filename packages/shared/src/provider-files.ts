import { z } from "zod";

/**
 * Custom provider files (`~/.config/bai/providers/<id>.json`).
 *
 * One file declares a provider's capabilities via a required `providerType`
 * (`text` / `image` / `video`), its endpoint/credentials, an optional chat
 * adapter block, and an optional image block. This is the single validated
 * contract shared by the file registry (core), the API routes, and the web
 * editor. JSONC (`//` comments) is tolerated by the reader, not this schema.
 */

/** Capabilities a provider file can declare. */
export type ProviderCapability = "text" | "image" | "video";

const hint = z.string().max(200).optional();
const key = z.string().min(1).max(64);
const label = z.string().min(1).max(100);

/** One `MediaParamSpec` option (enum kinds). */
export const mediaParamOptionSchema = z.object({ value: z.string(), label: z.string() });

/** The declarative parameter vocabulary an image provider exposes to the UI. */
export const mediaParamSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    key,
    label,
    kind: z.literal("enum"),
    options: z.array(mediaParamOptionSchema).min(1).max(100),
    default: z.string().optional(),
    hint,
  }),
  z.object({ key, label, kind: z.literal("toggle"), default: z.boolean().optional(), hint }),
  z.object({
    key,
    label,
    kind: z.literal("range"),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().optional(),
    default: z.number().optional(),
    unit: z.string().max(16).optional(),
    hint,
  }),
  z.object({
    key,
    label,
    kind: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.number().optional(),
    hint,
  }),
  z.object({
    key,
    label,
    kind: z.literal("text"),
    default: z.string().optional(),
    placeholder: z.string().max(200).optional(),
    hint,
  }),
  z.object({
    key,
    label,
    kind: z.literal("list"),
    itemKind: z.literal("text").default("text"),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(1).max(64).optional(),
    default: z.array(z.string()).optional(),
    hint,
  }),
]);

/** One selectable image model. */
export const mediaModelSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
  modes: z.array(z.enum(["t2i", "i2i"])).min(1),
  maxReferences: z.number().int().min(0).max(64).default(0),
  maxCount: z.number().int().min(1).max(64).default(1),
});

/** How the API key is sent (defaults to `Authorization: Bearer`). */
export const providerAuthSchema = z.object({
  header: z.string().min(1).max(64).default("authorization"),
  /** Empty string sends the key raw (no `Bearer ` prefix). */
  scheme: z.string().max(64).default("Bearer"),
});

/** How image-to-image reference bytes are attached (generic template). */
export const genericReferenceSchema = z.object({
  field: z.string().min(1).max(100),
  encoding: z.enum(["data-url", "base64"]).default("data-url"),
  /** Sibling field holding the mime type (object-per-reference form). */
  mimeField: z.string().min(1).max(100).optional(),
  wrap: z.enum(["array", "single"]).default("array"),
});

/** A generic request: method/path + a body template with `$`-tokens. */
export const genericRequestSchema = z.object({
  method: z.enum(["POST", "PUT"]).default("POST"),
  path: z.string().min(1).max(500).regex(/^\//, "path must start with /"),
  contentType: z.enum(["json", "multipart"]).default("json"),
  /** String leaves interpolate `$prompt $model $count $mode $width $height $seed $param.<key>`. */
  body: z.record(z.string(), z.unknown()).default({}),
  references: genericReferenceSchema.optional(),
});

/** Where the generated images + cost live in the response. */
export const genericResponseSchema = z
  .object({
    /** Tiny path to the image entry/array, e.g. `data[*]`, `images`. */
    images: z.string().min(1).max(200),
    /** Relative field within an entry holding base64 bytes. */
    base64: z.string().min(1).max(200).optional(),
    /** Relative field within an entry holding an image URL. */
    url: z.string().min(1).max(200).optional(),
    /** Relative field within an entry holding the mime type. */
    mime: z.string().min(1).max(200).optional(),
    /** Absolute path to a USD cost number, e.g. `usage.cost`. */
    costUsd: z.string().min(1).max(200).optional(),
  })
  .refine((r) => r.base64 !== undefined || r.url !== undefined, {
    message: "response must define base64 and/or url",
  });

/** Image capabilities using the built-in OpenAI-images wire template. */
export const openAiImagesSpecSchema = z.object({
  template: z.literal("openai-images"),
  defaultModel: z.string().min(1).max(200),
  models: z.array(mediaModelSchema).min(1).max(200),
  params: z.array(mediaParamSpecSchema).max(100).optional(),
  /** OpenAI-images supports multipart `/images/edits`; other i2i shapes use the generic template. */
  edit: z.enum(["multipart", "none"]).default("none"),
});

/** Image capabilities using the generic request/response mapping. */
export const genericImageSpecSchema = z.object({
  template: z.literal("generic"),
  defaultModel: z.string().min(1).max(200),
  models: z.array(mediaModelSchema).min(1).max(200),
  params: z.array(mediaParamSpecSchema).max(100).optional(),
  generate: genericRequestSchema,
  edit: genericRequestSchema.optional(),
  response: genericResponseSchema,
});

export const imageSpecSchema = z.discriminatedUnion("template", [
  openAiImagesSpecSchema,
  genericImageSpecSchema,
]);

/** One selectable video model (which workflows it supports). */
export const videoModelSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
  workflows: z
    .array(
      z.enum([
        "t2v",
        "i2v",
        "flf2v",
        "ref2v",
        "v2v",
        "extend",
        "upscale",
        "motion",
        "lipsync",
        "reframe",
      ]),
    )
    .min(1),
});

/** Where the generated videos + cost live in the response. */
export const genericVideoResponseSchema = z
  .object({
    /** Tiny path to the video entry/array, e.g. `data[*]`, `output`. */
    videos: z.string().min(1).max(200),
    /** Relative field within an entry holding base64 bytes. */
    base64: z.string().min(1).max(200).optional(),
    /** Relative field within an entry holding a video URL. */
    url: z.string().min(1).max(200).optional(),
    /** Relative field within an entry holding the mime type. */
    mime: z.string().min(1).max(200).optional(),
    /** Absolute path to a USD cost number, e.g. `usage.cost`. */
    costUsd: z.string().min(1).max(200).optional(),
  })
  .refine((r) => r.base64 !== undefined || r.url !== undefined, {
    message: "response must define base64 and/or url",
  });

/** Video capabilities using the generic request/response mapping. */
export const genericVideoSpecSchema = z.object({
  template: z.literal("generic"),
  defaultModel: z.string().min(1).max(200),
  models: z.array(videoModelSchema).min(1).max(200),
  params: z.array(mediaParamSpecSchema).max(100).optional(),
  generate: genericRequestSchema,
  response: genericVideoResponseSchema,
});

export const videoSpecSchema = genericVideoSpecSchema;

/** Chat (LLM) capabilities. */
export const textSpecSchema = z.object({
  adapter: z.enum(["openai-compatible", "openai", "anthropic", "responses"]).default("openai-compatible"),
  models: z.array(z.string().min(1).max(200)).max(1000).default([]),
  contextLength: z.number().int().positive().max(10_000_000).optional(),
});

/** Valid provider-file ids (also the filename stem). */
export const PROVIDER_FILE_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

export const providerFileSchema = z
  .object({
    /** Defaults to the filename stem when omitted. */
    id: z.string().regex(PROVIDER_FILE_ID_RE).optional(),
    name: z.string().min(1).max(100),
    providerType: z.array(z.enum(["text", "image", "video"])).min(1).max(3),
    baseUrl: z.string().url().max(2048),
    env: z.array(z.string().min(1).max(200)).max(10).optional(),
    apiKeyEnv: z.string().min(1).max(200).optional(),
    apiKey: z.string().min(1).max(4096).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    auth: providerAuthSchema.optional(),
    text: textSpecSchema.optional(),
    image: imageSpecSchema.optional(),
    video: videoSpecSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const has = (c: ProviderCapability): boolean => v.providerType.includes(c);
    if (new Set(v.providerType).size !== v.providerType.length) {
      ctx.addIssue({ code: "custom", path: ["providerType"], message: "providerType has duplicates" });
    }
    if (has("text") && v.text === undefined) {
      ctx.addIssue({ code: "custom", path: ["text"], message: 'providerType includes "text" but no text block' });
    }
    if (!has("text") && v.text !== undefined) {
      ctx.addIssue({ code: "custom", path: ["text"], message: 'text block present but providerType omits "text"' });
    }
    if (has("image") && v.image === undefined) {
      ctx.addIssue({ code: "custom", path: ["image"], message: 'providerType includes "image" but no image block' });
    }
    if (!has("image") && v.image !== undefined) {
      ctx.addIssue({ code: "custom", path: ["image"], message: 'image block present but providerType omits "image"' });
    }
    if (has("video") && v.video === undefined) {
      ctx.addIssue({ code: "custom", path: ["video"], message: 'providerType includes "video" but no video block' });
    }
    if (!has("video") && v.video !== undefined) {
      ctx.addIssue({ code: "custom", path: ["video"], message: 'video block present but providerType omits "video"' });
    }
  });

export type ProviderFile = z.infer<typeof providerFileSchema>;
export type ProviderFileImage = z.infer<typeof imageSpecSchema>;
export type ProviderFileText = z.infer<typeof textSpecSchema>;
export type GenericImageSpec = z.infer<typeof genericImageSpecSchema>;
export type ProviderFileVideo = z.infer<typeof videoSpecSchema>;
export type GenericVideoSpec = z.infer<typeof genericVideoSpecSchema>;
export type GenericRequest = z.infer<typeof genericRequestSchema>;
export type GenericResponse = z.infer<typeof genericResponseSchema>;
export type ProviderFileAuth = z.infer<typeof providerAuthSchema>;
