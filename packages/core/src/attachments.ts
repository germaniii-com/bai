import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  newId,
  systemClock,
  type Asset,
  type AssetId,
  type AttachmentKind,
  type AttachmentRef,
  type Clock,
} from "@bai/shared";
import type { Store } from "./store/store";
import { looksBinary } from "./tools/fs-guard";

/**
 * Attachment bytes live on disk (reusing the `assets` table with
 * `kind:"file"` + `meta.attachment`), never in SQLite or the event stream.
 * A small {@link AttachmentRef} rides the prompt payload and `attachment`
 * parts; providers get base64 built at render time.
 *
 * Classification is deliberately conservative: images (the provider-safe
 * png/jpeg/gif/webp set), PDF, and valid UTF-8 text are accepted; anything
 * else is rejected at upload. Which KINDS a given session may use is gated
 * later (`Service.assertAttachmentsSupported`): cwd-less chat sessions accept
 * images/PDF/text, while workspace sessions accept images only.
 */

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const PDF_MAX_BYTES = 32 * 1024 * 1024; // 32 MB
export const TEXT_MAX_BYTES = 1_000_000; // matches the #mention / fs.read text cap

/** Extensions normalized to a canonical image MIME (provider-safe set). */
const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Accepted image MIME types (Anthropic's Base64ImageSource set). */
const IMAGE_MIMES = new Set(Object.values(IMAGE_EXT_MIME));

export interface ClassifiedAttachment {
  kind: AttachmentKind;
  mime: string;
}

/** Canonical image MIME for a filename extension (mention-time detection). */
export function imageMimeFromName(name: string): string | undefined {
  return IMAGE_EXT_MIME[path.extname(name).slice(1).toLowerCase()];
}

/**
 * Provider-supported media by filename extension (mention-time detection):
 * images and PDFs. `#mention` in a workspace can attach both (text files are
 * read as context); the `+` upload path is gated separately by session.
 */
export function mediaFromName(name: string): { kind: "image" | "pdf"; mime: string } | undefined {
  const ext = path.extname(name).slice(1).toLowerCase();
  const imageMime = IMAGE_EXT_MIME[ext];
  if (imageMime !== undefined) return { kind: "image", mime: imageMime };
  if (ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  return undefined;
}

/** Per-kind upload cap in bytes. */
export function capFor(kind: AttachmentKind): number {
  return kind === "image" ? IMAGE_MAX_BYTES : kind === "pdf" ? PDF_MAX_BYTES : TEXT_MAX_BYTES;
}

/** Classify a stored MIME back into an attachment kind. */
export function attachmentKindOf(mime: string): AttachmentKind {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  return "text";
}

/**
 * Classify an uploaded file. Throws a user-facing Error for an unsupported
 * binary type. Text is accepted only when it is not binary.
 */
export function classifyAttachment(name: string, mime: string, bytes: Uint8Array): ClassifiedAttachment {
  const ext = path.extname(name).slice(1).toLowerCase();
  const declared = (mime.split(";")[0] ?? "").trim().toLowerCase();

  const imageMime = IMAGE_EXT_MIME[ext] ?? (IMAGE_MIMES.has(declared) ? declared : undefined);
  if (imageMime !== undefined) return { kind: "image", mime: imageMime };
  if (declared === "application/pdf" || ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  if (looksBinary(bytes)) {
    throw new Error(`Unsupported file type: ${name} (only images, PDF, and text files can be attached)`);
  }
  return { kind: "text", mime: declared.length > 0 && declared.startsWith("text/") ? declared : "text/plain" };
}

/** Asset-store kind used for every attachment (keeps media galleries clean). */
const ASSET_KIND: Asset["kind"] = "file";

export class AttachmentStore {
  private readonly clock: Clock;

  constructor(
    private deps: { store: Store; assetsDir: string; clock?: Clock },
  ) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Persist bytes for a prompt attachment. Returns the durable reference
   * carried on the prompt payload / `attachment` part.
   */
  save(bytes: Uint8Array, name: string, mime: string): AttachmentRef {
    const { kind, mime: canonical } = classifyAttachment(name, mime, bytes);
    const cap = capFor(kind);
    if (bytes.byteLength > cap) {
      throw new Error(`File too large: ${name} (${bytes.byteLength} bytes, cap ${cap})`);
    }
    const id = newId.asset();
    const dir = path.join(this.deps.assetsDir, "attachment");
    mkdirSync(dir, { recursive: true });
    const ext = safeExt(name, canonical);
    const filePath = path.join(dir, `${id}.${ext}`);
    writeFileSync(filePath, bytes);
    // The repo assigns the row id (opencode's asset pattern); use it for the
    // ref so /asset/:id/content and data() resolve.
    const asset = this.deps.store.assets.insert({
      kind: ASSET_KIND,
      mime: canonical,
      path: filePath,
      bytes: bytes.byteLength,
      meta: { attachment: true, name },
      now: this.clock.iso(),
    });
    return { id: asset.id, name, mime: canonical, bytes: asset.bytes, kind };
  }

  /** The durable asset row for an id, if present. */
  asset(id: AssetId | string): Asset | undefined {
    return this.deps.store.assets.get(id as AssetId);
  }

  /** Read the stored bytes (undefined when the id is unknown / file missing). */
  data(id: AssetId | string): Uint8Array | undefined {
    const asset = this.asset(id);
    if (asset === undefined) return undefined;
    try {
      return readFileSync(asset.path);
    } catch {
      return undefined;
    }
  }

  /** Rebuild the reference shape from a stored asset. */
  ref(id: AssetId | string): AttachmentRef | undefined {
    const asset = this.asset(id);
    if (asset === undefined) return undefined;
    return {
      id: asset.id,
      name: typeof asset.meta.name === "string" ? asset.meta.name : path.basename(asset.path),
      mime: asset.mime,
      bytes: asset.bytes,
      kind: attachmentKindOf(asset.mime),
    };
  }
}

/** Sanitized storage extension for a name/mime pair (never user-controlled). */
function safeExt(name: string, mime: string): string {
  const raw = path.extname(name).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(raw)) return raw;
  const slash = mime.indexOf("/");
  const sub = slash >= 0 ? mime.slice(slash + 1) : "";
  if (/^[a-z0-9.+-]{1,12}$/.test(sub)) return sub.split("+")[0] ?? "bin";
  return "bin";
}
