import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, Plus } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { AttachmentRef, Input, Message } from "@bai/shared";
import { Modal } from "./components";

/**
 * Transcript + composer rendering for stored attachments (`attachment` parts
 * = images/PDFs; text attachments ride a `file` part carrying an `assetId`).
 * Bytes are fetched with auth and turned into object URLs, mirroring the file
 * viewer's blob approach so the feature also works on a host-bound server.
 * Clicking an image thumbnail opens a maximized lightbox; PDF/text chips open
 * the blob in a new tab.
 */

export interface MediaAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  kind: "image" | "pdf";
}

function asMedia(payload: unknown): MediaAttachment | undefined {
  const p = payload as Partial<MediaAttachment> | null;
  if (p === null || typeof p !== "object") return undefined;
  if (typeof p.id !== "string" || typeof p.name !== "string" || typeof p.mime !== "string" || typeof p.bytes !== "number") return undefined;
  if (p.kind !== "image" && p.kind !== "pdf") return undefined;
  return { id: p.id, name: p.name, mime: p.mime, bytes: p.bytes, kind: p.kind };
}

/** Image/PDF attachments on a message, in part order. */
export function messageAttachments(message: Message): MediaAttachment[] {
  const out: MediaAttachment[] = [];
  for (const part of message.parts) {
    if (part.kind !== "attachment") continue;
    const media = asMedia(part.payload);
    if (media !== undefined) out.push(media);
  }
  return out;
}

/** Text attachments (a `file` part whose payload carries an `assetId`). */
export function messageTextAttachments(message: Message): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const part of message.parts) {
    if (part.kind !== "file") continue;
    const p = part.payload as { assetId?: unknown; path?: unknown } | null;
    if (p === null || typeof p.assetId !== "string") continue;
    out.push({ id: p.assetId, name: typeof p.path === "string" ? p.path : "file" });
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Auth-aware object URL for one stored asset (revoked on unmount). */
function useAssetUrl(client: BaiClient, id: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    let created: string | undefined;
    void client
      .assetContent(id)
      .then(async (res) => {
        const blob = await res.blob();
        if (!active) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => {
        // preview unavailable — the chip still shows the name
      });
    return () => {
      active = false;
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [client, id]);
  return url;
}

async function openAssetInTab(client: BaiClient, id: string): Promise<void> {
  try {
    const res = await client.assetContent(id);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank", "noopener");
  } catch {
    // preview unavailable
  }
}

/** A clickable image thumbnail that opens the lightbox. */
function ImageThumb({
  attachment,
  client,
  onOpen,
  className = "attachment-thumb",
}: {
  attachment: MediaAttachment;
  client: BaiClient;
  onOpen?: (a: MediaAttachment) => void;
  className?: string;
}) {
  const url = useAssetUrl(client, attachment.id);
  const title = `${attachment.name} (${formatBytes(attachment.bytes)})`;
  if (url === undefined) {
    return (
      <span className="attachment-chip" title={attachment.name}>
        <ImageIcon size={12} aria-hidden="true" />
        <span className="chip-label">{attachment.name}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="attachment-thumb-button"
      title={title}
      aria-label={`View ${attachment.name}`}
      disabled={onOpen === undefined}
      onClick={onOpen !== undefined ? () => onOpen(attachment) : undefined}
    >
      <img className={className} src={url} alt={attachment.name} />
    </button>
  );
}

/** A PDF/text chip that opens the stored blob in a new tab. */
function DocChip({ id, name, bytes, client }: { id: string; name: string; bytes: number | undefined; client: BaiClient }) {
  return (
    <button
      type="button"
      className="attachment-chip clickable"
      title={bytes !== undefined ? `${name} (${formatBytes(bytes)})` : name}
      onClick={() => void openAssetInTab(client, id)}
    >
      <FileText size={12} aria-hidden="true" />
      <span className="chip-label">{name}</span>
    </button>
  );
}

/** Renders a message's stored attachments (image thumbnails + file chips). */
export function AttachmentParts({
  message,
  client,
  onOpenImage,
}: {
  message: Message;
  client: BaiClient;
  onOpenImage?: (a: MediaAttachment) => void;
}) {
  const media = messageAttachments(message);
  const text = messageTextAttachments(message);
  if (media.length === 0 && text.length === 0) return null;
  return (
    <div className="attachments-row">
      {media.map((a) =>
        a.kind === "image" ? (
          <ImageThumb key={a.id} attachment={a} client={client} {...(onOpenImage !== undefined ? { onOpen: onOpenImage } : {})} />
        ) : (
          <DocChip key={a.id} id={a.id} name={a.name} bytes={a.bytes} client={client} />
        ),
      )}
      {text.map((a) => (
        <DocChip key={a.id} id={a.id} name={a.name} bytes={undefined} client={client} />
      ))}
    </div>
  );
}

/** Composer preview row above the input: thumbnails/chips with a remove control. */
export function AttachmentChips({
  attachments,
  client,
  onRemove,
  onOpenImage,
  disabled = false,
}: {
  attachments: AttachmentRef[];
  client: BaiClient;
  onRemove: (id: string) => void;
  onOpenImage?: (a: MediaAttachment) => void;
  disabled?: boolean;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="composer-attachments" aria-label="Attached files">
      {attachments.map((a) =>
        a.kind === "image" ? (
          <span key={a.id} className="composer-thumb">
            <ImageThumb
              attachment={{ ...a, kind: "image" }}
              client={client}
              className="composer-thumb-img"
              {...(onOpenImage !== undefined ? { onOpen: onOpenImage } : {})}
            />
            <RemoveButton id={a.id} name={a.name} disabled={disabled} onRemove={onRemove} />
          </span>
        ) : (
          <span key={a.id} className="attachment-chip static" title={`${a.name} (${formatBytes(a.bytes)})`}>
            <FileText size={12} aria-hidden="true" />
            <span className="chip-label">{a.name}</span>
            <RemoveButton id={a.id} name={a.name} disabled={disabled} onRemove={onRemove} inline />
          </span>
        ),
      )}
    </div>
  );
}

function RemoveButton({ id, name, disabled, onRemove, inline = false }: { id: string; name: string; disabled: boolean; onRemove: (id: string) => void; inline?: boolean }) {
  return (
    <button
      type="button"
      className={inline ? "attachment-remove" : "composer-thumb-remove"}
      aria-label={`Remove ${name}`}
      title="Remove"
      disabled={disabled}
      onClick={() => onRemove(id)}
    >
      ×
    </button>
  );
}

/** Queued-input attachment previews (from `input.payload.attachments`). */
export function QueuedAttachments({
  input,
  client,
  onOpenImage,
}: {
  input: Input;
  client: BaiClient;
  onOpenImage?: (a: MediaAttachment) => void;
}) {
  const refs = input.payload.attachments ?? [];
  if (refs.length === 0) return null;
  return (
    <div className="attachments-row">
      {refs.map((a) =>
        a.kind === "image" ? (
          <ImageThumb key={a.id} attachment={{ ...a, kind: "image" }} client={client} {...(onOpenImage !== undefined ? { onOpen: onOpenImage } : {})} />
        ) : (
          <DocChip key={a.id} id={a.id} name={a.name} bytes={a.bytes} client={client} />
        ),
      )}
    </div>
  );
}

/** Maximized image modal (Esc/backdrop/close button dismiss). */
export function ImageLightbox({
  attachment,
  client,
  onClose,
}: {
  attachment: MediaAttachment;
  client: BaiClient;
  onClose: () => void;
}) {
  const url = useAssetUrl(client, attachment.id);
  return (
    <Modal
      open
      onClose={onClose}
      title={attachment.name}
      size="lg"
      className="image-lightbox"
      bodyClassName="image-lightbox-body"
      ariaLabel={`Image: ${attachment.name}`}
    >
      {url !== undefined ? (
        <img className="image-lightbox-img" src={url} alt={attachment.name} />
      ) : (
        <p className="dim">Loading image…</p>
      )}
    </Modal>
  );
}

const DOCUMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.toml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.rb,.php,.sql";

/** The `+` attach control (chat only): opens the OS picker. */
export function AttachButton({ onFiles, disabled = false }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-outline btn-lg attachment-add"
        aria-label="Attach files"
        data-tooltip="Attach images, PDF, or text files"
        disabled={disabled}
        onClick={() => input?.click()}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      <input
        ref={setInput}
        type="file"
        multiple
        hidden
        accept={DOCUMENT_ACCEPT}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}
